import apigateway = require("@aws-cdk/aws-apigateway");
import cdk = require("@aws-cdk/cdk");
import dynamodb = require("@aws-cdk/aws-dynamodb");
import lambda = require("@aws-cdk/aws-lambda");
import cognito = require("@aws-cdk/aws-cognito");
import {BillingMode, StreamViewType} from "@aws-cdk/aws-dynamodb";
import "source-map-support/register";
import {AuthorizationType} from "@aws-cdk/aws-apigateway";
import {CognitoAppClientCustomResourceConstruct} from "./customResourceConstructs/cognitoAppClientCustomResourceConstruct";
import {CfnUserPool} from "@aws-cdk/aws-cognito";
import {CognitoDomainCustomResourceConstruct} from "./customResourceConstructs/cognitoDomainCustomResourceConstruct";
import {CognitoPreTokenGenerationResourceConstruct} from "./customResourceConstructs/cognitoPreTokenGenerationResourceConstruct";
import {CognitoIdPCustomResourceConstruct} from "./customResourceConstructs/cognitoIdPCustomResourceConstruct";
import {AttributeMappingType} from "aws-sdk/clients/cognitoidentityserviceprovider";
import {Utils} from "./utils";
import {Function, Runtime} from "@aws-cdk/aws-lambda";

/**
 * Define a CloudFormation stack that creates a serverless application with
 * Amazon Cognito and an external SAML based IdP
 */
export class AmazonCognitoIdPExampleStack extends cdk.Stack {

  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ========================================================================
    // Environment variables and constants
    // ========================================================================

    const domain = Utils.getEnv("COGNITO_DOMAIN_NAME");
    const identityProviderName = Utils.getEnv("IDENTITY_PROVIDER_NAME");
    const identityProviderMetadataURL = Utils.getEnv("IDENTITY_PROVIDER_METADATA_URL");

    const groupsAttributeName = Utils.getEnv("GROUPS_ATTRIBUTE_NAME", "groups");
    const allowedOrigin = Utils.getEnv("ALLOWED_ORIGIN", "*");
    const adminsGroupName = Utils.getEnv("ADMINS_GROUP_NAME", "pet-app-admins");
    const usersGroupName = Utils.getEnv("USERS_GROUP_NAME", "pet-app-admins");
    const lambdaMemory = parseInt(Utils.getEnv("LAMBDA_MEMORY", "128"));


    const nodeRuntime: Runtime = lambda.Runtime.NodeJS810;
    const tokenHeaderName = "Authorization";
    const groupsAttributeClaimName = "custom:" + groupsAttributeName;

    // ========================================================================
    // Resource: Amazon Cognito User Pool
    // ========================================================================

    // Purpose: creates a user directory and allows federation from external IdPs

    // See also:
    // - https://aws.amazon.com/cognito/
    // - https://docs.aws.amazon.com/cdk/api/latest/docs/@aws-cdk_aws-cognito.CfnIdentityPool.html

    const userPool: CfnUserPool = new cognito.CfnUserPool(this, id + "Pool", {
      usernameAttributes: ["email"],
      schema: [{
        name: groupsAttributeName,
        attributeDataType: "String",
        mutable: true,
        required: false,
        stringAttributeConstraints: {
          maxLength: "2000"
        }
      }],
      autoVerifiedAttributes: ["email"]
    });

    // ========================================================================
    // Resource: Amazon DynamoDB Table
    // ========================================================================

    // Purpose: serverless, pay as you go, persistent storage for the demo app

    // See also:
    // - https://aws.amazon.com/dynamodb/
    // - https://docs.aws.amazon.com/cdk/api/latest/docs/aws-dynamodb-readme.html

    const table = new dynamodb.Table(this, "Table", {
      billingMode: BillingMode.PayPerRequest,
      sseEnabled: true,
      streamSpecification: StreamViewType.NewAndOldImages, // to enable global tables
      partitionKey: {name: "id", type: dynamodb.AttributeType.String}
    });

    // ========================================================================
    // Resource: AWS Lambda Function - CRUD API Backend
    // ========================================================================

    // Purpose: serverless backend for the demo app, uses express.js

    // See also:
    // - https://aws.amazon.com/lambda/
    // - https://docs.aws.amazon.com/cdk/api/latest/docs/aws-lambda-readme.html

    const apiFunction = new lambda.Function(this, "APIFunction", {
      runtime: nodeRuntime,
      handler: "index.handler",
      code: lambda.Code.asset("../lambda/api/dist/packed"),
      timeout: 30,
      memorySize: lambdaMemory,
      environment: {
        TABLE_NAME: table.tableName,
        ALLOWED_ORIGIN: allowedOrigin,
        ADMINS_GROUP_NAME: adminsGroupName,
        USERS_GROUP_NAME: usersGroupName
      },
    });

    // grant the lambda full access to the table
    table.grantFullAccess(apiFunction.role!);

    // ========================================================================
    // Resource: Amazon API Gateway - API endpoints
    // ========================================================================

    // Purpose: create API endpoints and integrate with Amazon Cognito for JWT validation

    // See also:
    // - https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-integrate-with-cognito.html

    // ------------------------------------------------------------------------
    // The API
    // ------------------------------------------------------------------------

    const api = new apigateway.RestApi(this, id + "API");
    const integration = new apigateway.LambdaIntegration(apiFunction, {
      // lambda proxy integration:
      // see https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-create-api-as-simple-proxy
      proxy: true
    });

    // ------------------------------------------------------------------------
    // Cognito Authorizer
    // ------------------------------------------------------------------------

    const cfnAuthorizer = new apigateway.CfnAuthorizer(this, id, {
      name: "CognitoAuthorizer",
      type: AuthorizationType.Cognito,
      identitySource: "method.request.header." + tokenHeaderName,
      restApiId: api.restApiId,
      providerArns: [userPool.userPoolArn]
    });

    // ------------------------------------------------------------------------
    // Root (/) - no authorization required
    // ------------------------------------------------------------------------

    const rootResource = api.root;

    rootResource.addMethod("ANY", integration);

    // ------------------------------------------------------------------------
    // All Other Paths (/{proxy+}) - authorization required
    // ------------------------------------------------------------------------

    // all other paths require the cognito authorizer (validates the JWT and passes it to the lambda)

    const proxyResource = rootResource.addResource("{proxy+}");

    proxyResource.addMethod("ANY", integration, {
      authorizerId: cfnAuthorizer.authorizerId,
      authorizationType: AuthorizationType.Cognito,
    });

    // ------------------------------------------------------------------------
    // // add CORS support to all
    // ------------------------------------------------------------------------

    Utils.addCorsOptions(proxyResource, allowedOrigin);
    Utils.addCorsOptions(rootResource, allowedOrigin);



    // ========================================================================
    // Resource: Pre Token Generation function
    // ========================================================================

    // Purpose: map from a custom attribute mapped from SAML, e.g. {..., "custom:groups":"[a,b,c]", ...}
    //          to cognito:groups claim, e.g. {..., "cognito:groups":["a","b","c"], ...}

    // See also:
    // - https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html

    const preTokenGeneration: Function = new lambda.Function(this, "PreTokenGeneration", {
      runtime: nodeRuntime,
      handler: "index.handler",
      code: lambda.Code.asset("../lambda/pretokengeneration/dist/src"),
      environment: {
        GROUPS_ATTRIBUTE_NAME: groupsAttributeClaimName,
      },
    });

    new CognitoPreTokenGenerationResourceConstruct(this, "CognitoPreTokenGen", userPool, preTokenGeneration);

    // ========================================================================
    // Resource: Identity Provider Settings
    // ========================================================================

    // Purpose: define the external Identity Provider details, field mappings etc.

    // See also:
    // - https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html

    // mapping from IdP fields to Cognito attributes (key is cognito attribute, value is mapped field name)
    const attributeMapping: AttributeMappingType = {
      "email": "email",
      "family_name": "lastName",
      "name": "firstName"
    };
    attributeMapping[groupsAttributeClaimName] = "groups";

    const cognitoIdPConstruct = new CognitoIdPCustomResourceConstruct(this, "CognitoIdP", {
      ProviderName: identityProviderName,
      ProviderDetails: {
        IDPSignout: "true",
        MetadataURL: identityProviderMetadataURL
      },
      ProviderType: "SAML",
      AttributeMapping: attributeMapping
    }, userPool);

    // ========================================================================
    // Resource: Cognito App Client
    // ========================================================================

    // Purpose: each app needs an app client defined, where app specific details are set, such as redirect URIs

    // See also:
    // - https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-client-apps.html

    const cognitoAppClient = new CognitoAppClientCustomResourceConstruct(this, "CognitoAppClient", {
      SupportedIdentityProviders: ["COGNITO", identityProviderName],
      ClientName: "Web",
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["phone", "email", "openid", "profile"],
      GenerateSecret: false,
      RefreshTokenValidity: 1,
      //TODO: add your app's prod URLs here
      CallbackURLs: ["http://localhost:3000/"],
      LogoutURLs: ["http://localhost:3000/"],

    }, userPool);

    // we want to make sure we do things in the right order
    cognitoAppClient.node.addDependency(cognitoIdPConstruct);

    // ========================================================================
    // Resource: Cognito Auth Domain
    // ========================================================================

    // Purpose: creates / updates the custom subdomain for cognito's hosted UI

    // See also:
    // https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-assign-domain.html

    const cognitoDomain = new CognitoDomainCustomResourceConstruct(this, "CognitoDomain", {
      Domain: domain,
    }, userPool);

    // ========================================================================
    // Stack Outputs
    // ========================================================================

    // Publish the custom resource output
    new cdk.CfnOutput(this, "APIUrlOutput", {
      description: "API URL",
      value: api.url
    });

    new cdk.CfnOutput(this, "UserPoolIdOutput", {
      description: "UserPool ID",
      value: userPool.userPoolId
    });

    new cdk.CfnOutput(this, "AppClientIdOutput", {
      description: "App Client ID",
      value: cognitoAppClient.appClientId
    });

    new cdk.CfnOutput(this, "RegionOutput", {
      description: "Region",
      value: cognitoDomain.region
    });

    new cdk.CfnOutput(this, "CognitoDomainOutput", {
      description: "Cognito Domain",
      value: cognitoDomain.domain
    });
  }
}


// generate the CDK app and stack

const app = new cdk.App();

const stackName = Utils.getEnv("STACK_NAME");
const stackAccount = Utils.getEnv("STACK_ACCOUNT");
const stackRegion = Utils.getEnv("STACK_REGION");


// The AWS CDK team recommends that you explicitly set your account and region using the env property on a stack when
// you deploy stacks to production.
// see https://docs.aws.amazon.com/cdk/latest/guide/getting_started.html

new AmazonCognitoIdPExampleStack(app, stackName, {env: {region: stackRegion, account: stackAccount}});
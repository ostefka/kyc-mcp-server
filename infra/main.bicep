// KYC MCP Server Infrastructure
// Deploys: Container Apps Environment, Container App, Container Registry, Document Intelligence

@description('Location for all resources')
param location string = resourceGroup().location

@description('Unique suffix for resource names')
param uniqueSuffix string = uniqueString(resourceGroup().id)

@description('MCP API Key for authentication')
@secure()
param mcpApiKey string

@description('Dataverse URL (e.g., https://yourorg.crm.dynamics.com)')
param dataverseUrl string

@description('Dataverse App Registration Client ID')
param dataverseClientId string

@description('Dataverse App Registration Client Secret')
@secure()
param dataverseClientSecret string

@description('Azure AD Tenant ID')
param tenantId string

@description('Perplexity API Key (optional, for adverse media screening)')
@secure()
param perplexityApiKey string = ''

// Container Registry
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'acr${uniqueSuffix}'
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true
  }
}

// Document Intelligence
resource docIntelligence 'Microsoft.CognitiveServices/accounts@2023-10-01-preview' = {
  name: 'docint-${uniqueSuffix}'
  location: location
  kind: 'FormRecognizer'
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: 'docint-${uniqueSuffix}'
    publicNetworkAccess: 'Enabled'
  }
}

// Log Analytics Workspace (required for Container Apps)
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: 'log-${uniqueSuffix}'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// Container Apps Environment
resource containerAppsEnv 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: 'cae-kyc-${uniqueSuffix}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// Container App - MCP Server
resource mcpServer 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'kyc-mcp-server'
  location: location
  properties: {
    managedEnvironmentId: containerAppsEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
      }
      registries: [
        {
          server: acr.properties.loginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: [
        {
          name: 'acr-password'
          value: acr.listCredentials().passwords[0].value
        }
        {
          name: 'mcp-api-key'
          value: mcpApiKey
        }
        {
          name: 'dataverse-client-secret'
          value: dataverseClientSecret
        }
        {
          name: 'doc-intelligence-key'
          value: docIntelligence.listKeys().key1
        }
        {
          name: 'perplexity-key'
          value: perplexityApiKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'kyc-mcp-server'
          // Initially use a placeholder image - user will build and push their own
          image: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'PORT'
              value: '8080'
            }
            {
              name: 'MCP_API_KEY'
              secretRef: 'mcp-api-key'
            }
            {
              name: 'DATAVERSE_URL'
              value: dataverseUrl
            }
            {
              name: 'DATAVERSE_CLIENT_ID'
              value: dataverseClientId
            }
            {
              name: 'DATAVERSE_CLIENT_SECRET'
              secretRef: 'dataverse-client-secret'
            }
            {
              name: 'DATAVERSE_TENANT_ID'
              value: tenantId
            }
            {
              name: 'DOC_INTELLIGENCE_ENDPOINT'
              value: 'https://${docIntelligence.properties.endpoint}'
            }
            {
              name: 'DOC_INTELLIGENCE_KEY'
              secretRef: 'doc-intelligence-key'
            }
            {
              name: 'PERPLEXITY_API_KEY'
              secretRef: 'perplexity-key'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
      }
    }
  }
}

// Outputs
output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
output mcpServerUrl string = 'https://${mcpServer.properties.configuration.ingress.fqdn}'
output docIntelligenceEndpoint string = docIntelligence.properties.endpoint
output containerAppName string = mcpServer.name
output containerAppsEnvName string = containerAppsEnv.name


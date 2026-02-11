# KYC MCP Server

MCP Server for KYC document evaluation that connects Copilot Studio to Dataverse, Azure Document Intelligence, GLEIF, and Perplexity AI.

## Deploy to Azure

Click the button below to deploy all required Azure infrastructure:

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fostefka%2Fkyc-mcp-server%2Fmaster%2Fazuredeploy.json)

### What Gets Deployed
- **Azure Container Apps** - Hosts the MCP server
- **Azure Container Registry** - Stores Docker images
- **Azure Document Intelligence** - OCR for document processing
- **Log Analytics Workspace** - For monitoring

### Prerequisites
Before deploying, you need:
1. **Dataverse environment** with KYC tables (cr_kyccustomer, cr_kycdocument)
2. **Entra ID App Registration** with Dataverse API permissions
3. **(Optional)** Perplexity API key for adverse media screening

## Features

### Customer & Document Tools
- **list_customers** - List all KYC customers with optional status filter
- **get_customer** - Get customer details by ID or name
- **get_customer_documents** - List documents for a customer
- **read_document_content** - Extract text from a document (offline or via Azure Document Intelligence)
- **update_customer_status** - Update customer KYC status
- **get_kyc_summary** - Get summary statistics

### Legal Entity Verification Tools
- **search_company** - Search GLEIF database for company by name (returns LEI, address, jurisdiction)
- **verify_lei** - Verify a 20-character LEI code against GLEIF database
- **screen_adverse_media** - Screen entity for sanctions, fraud, lawsuits using Perplexity AI
- **run_legal_entity_kyc** - Combined KYC check (GLEIF + LEI + Adverse Media screening)

## Offline Mode

When Azure Document Intelligence is not available, the server can run in **offline mode**:
- Set `OFFLINE_MODE=true` or omit `DOC_INTELLIGENCE_KEY`
- Documents must have text pre-entered in the `cr_extractedtext` field in Dataverse
- Use the Power App to manually enter extracted PDF text

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 8080) |
| `MCP_API_KEY` | **Yes** | API key for authentication |
| `DATAVERSE_URL` | **Yes** | Your Dataverse URL (e.g., https://yourorg.crm.dynamics.com) |
| `DATAVERSE_CLIENT_ID` | **Yes** | App registration client ID |
| `DATAVERSE_CLIENT_SECRET` | **Yes** | App registration client secret |
| `DATAVERSE_TENANT_ID` | **Yes** | Azure AD tenant ID |
| `OFFLINE_MODE` | No | Set to "true" to use pre-extracted text from Dataverse |
| `DOC_INTELLIGENCE_ENDPOINT` | No | Azure Document Intelligence endpoint |
| `DOC_INTELLIGENCE_KEY` | No | Azure Document Intelligence key (if not set, offline mode is used) |
| `PERPLEXITY_API_KEY` | No | Perplexity AI API key for adverse media screening |

## Local Development

```bash
# Install dependencies
npm install

# Set environment variables
export MCP_API_KEY="your-secret-key"
export DATAVERSE_CLIENT_ID="..."
export DATAVERSE_CLIENT_SECRET="..."
export DATAVERSE_TENANT_ID="your-tenant-id"
export DOC_INTELLIGENCE_KEY="..."
export PERPLEXITY_API_KEY="..."  # Optional: for adverse media screening

# Run server
npm start
```

## Docker Build & Deploy

After deploying the Azure infrastructure, build and push your container:

```bash
# Get ACR name from deployment outputs (or Azure Portal)
ACR_NAME="your-acr-name"

# Login to ACR
az acr login --name $ACR_NAME

# Build image
docker build -t $ACR_NAME.azurecr.io/kyc-mcp-server:v1 .

# Push to ACR
docker push $ACR_NAME.azurecr.io/kyc-mcp-server:v1

# Update Container App to use your image
az containerapp update \
  --name kyc-mcp-server \
  --resource-group YOUR_RESOURCE_GROUP \
  --image $ACR_NAME.azurecr.io/kyc-mcp-server:v1
```

### Local Docker Testing

```bash
# Build image
docker build -t kyc-mcp-server .

# Run locally
docker run -p 8080:8080 \
  -e MCP_API_KEY="..." \
  -e DATAVERSE_CLIENT_ID="..." \
  -e DATAVERSE_CLIENT_SECRET="..." \
  -e DATAVERSE_TENANT_ID="..." \
  -e DOC_INTELLIGENCE_KEY="..." \
  kyc-mcp-server
```

## Azure Container Apps Deployment

```bash
az containerapp create \
  --name kyc-mcp-server \
  --resource-group YOUR_RESOURCE_GROUP \
  --environment YOUR_CONTAINER_APPS_ENV \
  --image YOUR_ACR.azurecr.io/kyc-mcp-server:latest \
  --registry-server YOUR_ACR.azurecr.io \
  --target-port 8080 \
  --ingress external \
  --env-vars \
    MCP_API_KEY=secretref:mcp-api-key \
    DATAVERSE_CLIENT_ID=secretref:dv-client-id \
    DATAVERSE_CLIENT_SECRET=secretref:dv-client-secret \
    DATAVERSE_TENANT_ID=YOUR_TENANT_ID \
    DOC_INTELLIGENCE_KEY=secretref:doc-intel-key
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server info |
| `/health` | GET | Health check |
| `/test-dataverse` | GET | Test Dataverse connectivity |
| `/mcp` | POST/GET/DELETE | MCP Streamable HTTP transport |

## Authentication

Include API key in requests:

```http
x-api-key: your-api-key
```

Or:

```http
Authorization: Bearer your-api-key
```

## Copilot Studio Configuration

1. Go to Copilot Studio → Actions → Add MCP Server
2. Configure:
   - **URL**: `https://kyc-mcp-server.<env>.azurecontainerapps.io/mcp`
   - **Authentication**: API Key
   - **API Key Header**: `x-api-key`
   - **API Key Value**: Your MCP_API_KEY

## Testing

```bash
# Health check
curl http://localhost:8080/health

# Test Dataverse (with API key)
curl -H "x-api-key: your-key" http://localhost:8080/test-dataverse

# MCP Initialize
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-key" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test"}},"id":1}'
```

# KYC MCP Server Setup Guide

## Step 1: Register Application User in Power Platform

The MCP server uses client credentials (app-only auth) to access Dataverse. You need to register it as an Application User.

### Create App Registration in Entra ID:

1. Go to [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations**
2. Click **+ New registration**
3. Name: `KYC MCP Server`
4. Supported account types: **Single tenant**
5. Click **Register**
6. Copy the **Application (client) ID** - you'll need this
7. Go to **Certificates & secrets** → **+ New client secret**
8. Copy the secret value - you'll need this

### Register as Application User in Power Platform:

1. Go to [Power Platform Admin Center](https://admin.powerplatform.microsoft.com)
2. Navigate to **Environments** → Select your environment
3. Click **Settings** → **Users + permissions** → **Application users**
4. Click **+ New app user**
5. Select **+ Add an app**
6. Search for your app by the **Application (client) ID** from step 6 above
7. Click **Add**
8. Select **Business unit**: The root business unit
9. Click **Edit security roles** → Add **System Administrator** (or a custom role with read/write access to KYC tables)
10. Click **Create**

## Step 2: Create Dataverse Tables

Create these two tables in your Dataverse environment:

### KYC Customer Table (cr_kyccustomer)
| Column | Type | Description |
|--------|------|-------------|
| cr_customername | Text | Customer name |
| cr_email | Text | Email address |
| cr_dateofbirth | Date | Date of birth |
| cr_status | Choice | 1=Pending, 2=Under Review, 3=Approved, 4=Rejected |

### KYC Document Table (cr_kycdocument)
| Column | Type | Description |
|--------|------|-------------|
| cr_documenttype | Choice | 1=ID, 2=Proof of Address, 3=Income Statement |
| cr_filename | Text | Original filename |
| cr_fileurl | Text | URL to document (e.g., SharePoint, blob storage) |
| cr_extractedtext | Multiline Text | Pre-extracted text (for offline mode) |
| cr_customerid | Lookup | Link to cr_kyccustomer |

## Step 3: Deploy to Azure

### Option A: One-Click Deploy (Recommended)

Click the **Deploy to Azure** button in the README to automatically create:
- Container Apps Environment
- Container Registry
- Document Intelligence
- Container App

### Option B: Manual Deployment

#### Build and Push to ACR:

```powershell
cd mcp-server

# Build Docker image
docker build -t kyc-mcp-server .

# Tag for your ACR
docker tag kyc-mcp-server YOUR_ACR.azurecr.io/kyc-mcp-server:latest

# Login to ACR
az acr login --name YOUR_ACR

# Push to ACR
docker push YOUR_ACR.azurecr.io/kyc-mcp-server:latest
```

#### Deploy Container App:

```powershell
# Generate a secure API key
$ApiKey = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([System.Guid]::NewGuid().ToString()))
Write-Host "Generated API Key: $ApiKey"

# Create Container App
az containerapp create `
  --name kyc-mcp-server `
  --resource-group YOUR_RESOURCE_GROUP `
  --environment YOUR_CONTAINER_APPS_ENV `
  --image YOUR_ACR.azurecr.io/kyc-mcp-server:latest `
  --registry-server YOUR_ACR.azurecr.io `
  --target-port 8080 `
  --ingress external `
  --min-replicas 1 `
  --max-replicas 3 `
  --secrets `
    mcp-api-key=$ApiKey `
    dv-client-secret=YOUR_DATAVERSE_CLIENT_SECRET `
    doc-intel-key=YOUR_DOC_INTELLIGENCE_KEY `
  --env-vars `
    MCP_API_KEY=secretref:mcp-api-key `
    DATAVERSE_CLIENT_ID=YOUR_DATAVERSE_CLIENT_ID `
    DATAVERSE_CLIENT_SECRET=secretref:dv-client-secret `
    DATAVERSE_TENANT_ID=YOUR_TENANT_ID `
    DATAVERSE_URL=https://YOUR_ORG.crm.dynamics.com `
    DOC_INTELLIGENCE_ENDPOINT=https://YOUR_DOC_INT.cognitiveservices.azure.com/ `
    DOC_INTELLIGENCE_KEY=secretref:doc-intel-key
```

### Get the Container App URL:

```powershell
az containerapp show --name kyc-mcp-server --resource-group YOUR_RESOURCE_GROUP --query "properties.configuration.ingress.fqdn" -o tsv
```

## Step 4: Configure Copilot Studio

1. Open [Copilot Studio](https://copilotstudio.microsoft.com)
2. Create a new agent or open existing
3. Go to **Actions** → **+ Add action** → **MCP Server**
4. Configure:
   - **Name**: KYC Document Evaluation
   - **URL**: `https://kyc-mcp-server.<env>.azurecontainerapps.io/mcp`
   - **Authentication**: API Key
   - **Header name**: `x-api-key`
   - **API Key**: (the key you generated)
5. **Test connection** to verify

## Available MCP Tools

Once configured, the following tools will be available in Copilot Studio:

| Tool | Description |
|------|-------------|
| `list_customers` | List all KYC customers, optionally filter by status |
| `get_customer` | Get details of a specific customer by ID or name |
| `get_customer_documents` | List all documents uploaded for a customer |
| `read_document_content` | Extract text from a document using Azure Document Intelligence |
| `update_customer_status` | Update the KYC status (Pending/Under Review/Approved/Rejected) |
| `get_kyc_summary` | Get summary statistics of KYC applications |
| `search_company` | Search GLEIF database for company by name |
| `verify_lei` | Verify a Legal Entity Identifier (LEI) code |
| `screen_adverse_media` | Screen for sanctions, fraud, lawsuits using Perplexity AI |
| `run_legal_entity_kyc` | Combined company verification (GLEIF + LEI + Adverse Media) |

## Example Agent Instructions

Add these instructions to your Copilot Studio agent:

```
You are a KYC (Know Your Customer) verification assistant for a bank. Your job is to help compliance officers review and verify customer documentation.

When evaluating a customer:
1. First, use `get_customer` to retrieve customer details
2. Use `get_customer_documents` to see what documents are uploaded
3. For each document, use `read_document_content` to extract and read the text
4. Verify that:
   - ID documents match the customer's name and date of birth
   - Proof of address is recent (within 3 months) and matches customer details
   - Income statements are authentic and meet minimum requirements
5. Based on your evaluation, use `update_customer_status` to approve or reject

For legal entity verification:
1. Use `run_legal_entity_kyc` with the company name to perform comprehensive checks
2. This will verify the company exists in GLEIF, validate any LEI code, and screen for adverse media

If you need clarification or documents are missing/unclear, recommend keeping the status as "Under Review" and explain what additional information is needed.
```

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_API_KEY` | Yes | API key for Copilot Studio authentication |
| `DATAVERSE_URL` | Yes | Your Dataverse URL (e.g., https://yourorg.crm.dynamics.com) |
| `DATAVERSE_CLIENT_ID` | Yes | App registration client ID |
| `DATAVERSE_CLIENT_SECRET` | Yes | App registration client secret |
| `DATAVERSE_TENANT_ID` | Yes | Your Azure AD tenant ID |
| `DOC_INTELLIGENCE_ENDPOINT` | No | Azure Document Intelligence endpoint |
| `DOC_INTELLIGENCE_KEY` | No | Azure Document Intelligence key |
| `PERPLEXITY_API_KEY` | No | Perplexity AI key for adverse media screening |

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import crypto from "crypto";
import https from "https";
import { z } from "zod";

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 8080;

// API Key for authentication - REQUIRED for production
const API_KEY = process.env.MCP_API_KEY;

// Dataverse configuration
const DATAVERSE_URL = process.env.DATAVERSE_URL;
const DATAVERSE_CLIENT_ID = process.env.DATAVERSE_CLIENT_ID;
const DATAVERSE_CLIENT_SECRET = process.env.DATAVERSE_CLIENT_SECRET;
const DATAVERSE_TENANT_ID = process.env.DATAVERSE_TENANT_ID;

// Azure Document Intelligence configuration
const DOC_INTELLIGENCE_ENDPOINT = process.env.DOC_INTELLIGENCE_ENDPOINT;
const DOC_INTELLIGENCE_KEY = process.env.DOC_INTELLIGENCE_KEY;

// Perplexity AI configuration (for adverse media screening)
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

if (!API_KEY) {
  console.warn("⚠️  WARNING: MCP_API_KEY not set - server is NOT secured!");
}

if (!DATAVERSE_CLIENT_ID || !DATAVERSE_CLIENT_SECRET || !DATAVERSE_TENANT_ID) {
  console.warn("⚠️  WARNING: Dataverse credentials not fully configured!");
}

if (!DOC_INTELLIGENCE_KEY) {
  console.warn("⚠️  WARNING: DOC_INTELLIGENCE_KEY not set - document text extraction will not work!");
}

if (!PERPLEXITY_API_KEY) {
  console.warn("⚠️  WARNING: PERPLEXITY_API_KEY not set - adverse media screening will not work!");
}

// ============================================================================
// DATAVERSE CLIENT
// ============================================================================

let dataverseToken = null;
let tokenExpiry = 0;

async function getDataverseToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (dataverseToken && Date.now() < tokenExpiry - 300000) {
    return dataverseToken;
  }

  console.log("[Dataverse] Acquiring new access token...");

  const tokenUrl = `https://login.microsoftonline.com/${DATAVERSE_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: DATAVERSE_CLIENT_ID,
    client_secret: DATAVERSE_CLIENT_SECRET,
    scope: `${DATAVERSE_URL}/.default`,
    grant_type: "client_credentials",
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get Dataverse token: ${error}`);
  }

  const data = await response.json();
  dataverseToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;

  console.log("[Dataverse] Token acquired successfully");
  return dataverseToken;
}

async function callDataverse(endpoint, method = "GET", body = null) {
  const token = await getDataverseToken();
  const url = `${DATAVERSE_URL}/api/data/v9.2/${endpoint}`;

  console.log(`[Dataverse] ${method} ${endpoint}`);

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Accept: "application/json",
      Prefer: "return=representation",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Dataverse API error ${response.status}: ${error}`);
  }

  // Handle 204 No Content for PATCH/DELETE
  if (response.status === 204) {
    return { success: true };
  }

  return response.json();
}

// ============================================================================
// AZURE DOCUMENT INTELLIGENCE CLIENT
// ============================================================================

async function extractTextFromDocument(base64Content, mimeType) {
  if (!DOC_INTELLIGENCE_KEY) {
    throw new Error("Document Intelligence not configured");
  }

  console.log(`[DocIntelligence] Extracting text from ${mimeType}...`);

  // Convert base64 to bytes
  const fileBytes = Buffer.from(base64Content, "base64");

  // Call Azure Document Intelligence REST API
  const analyzeUrl = `${DOC_INTELLIGENCE_ENDPOINT}documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`;

  const response = await fetch(analyzeUrl, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": DOC_INTELLIGENCE_KEY,
      "Content-Type": mimeType || "application/pdf",
    },
    body: fileBytes,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Document Intelligence error ${response.status}: ${error}`);
  }

  // Get the operation location for polling
  const operationLocation = response.headers.get("Operation-Location");
  if (!operationLocation) {
    throw new Error("No operation location returned from Document Intelligence");
  }

  console.log("[DocIntelligence] Waiting for analysis to complete...");

  // Poll for completion
  let result;
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const pollResponse = await fetch(operationLocation, {
      headers: {
        "Ocp-Apim-Subscription-Key": DOC_INTELLIGENCE_KEY,
      },
    });

    if (!pollResponse.ok) {
      const error = await pollResponse.text();
      throw new Error(`Polling error: ${error}`);
    }

    result = await pollResponse.json();

    if (result.status === "succeeded") {
      break;
    } else if (result.status === "failed") {
      throw new Error(`Analysis failed: ${JSON.stringify(result.error)}`);
    }
  }

  if (result.status !== "succeeded") {
    throw new Error("Analysis timed out");
  }

  // Extract text content from result
  const content = result.analyzeResult?.content || "";
  const pages = result.analyzeResult?.pages || [];

  console.log(`[DocIntelligence] Extracted ${content.length} characters from ${pages.length} pages`);

  return {
    content,
    pageCount: pages.length,
    confidence: result.analyzeResult?.pages?.[0]?.words?.[0]?.confidence || null,
  };
}

// ============================================================================
// MCP SERVER FACTORY
// ============================================================================

function createMcpServer() {
  const mcpServer = new McpServer({
    name: "KYC Document Evaluation",
    version: "1.0.0",
  });

  // --------------------------------------------------------------------------
  // TOOL: List Customers
  // --------------------------------------------------------------------------
  mcpServer.tool(
    "list_customers",
    "List all KYC customers. Can filter by status (1=Pending, 2=Under Review, 3=Approved, 4=Rejected).",
    {
      status: z.number().optional().describe("Filter by status: 1=Pending, 2=Under Review, 3=Approved, 4=Rejected"),
    },
    async ({ status }) => {
      console.log(`[Tool] list_customers called with status=${status}`);
      try {
        let query = "cr_kyccustomers?$select=cr_kyccustomerid,cr_fullname,cr_firstname,cr_lastname,cr_email,cr_status,cr_idtype,cr_idnumber,createdon&$orderby=createdon desc";
        if (status) {
          query += `&$filter=cr_status eq ${status}`;
        }

        const result = await callDataverse(query);
        const customers = result.value.map((c) => ({
          id: c.cr_kyccustomerid,
          fullName: c.cr_fullname || `${c.cr_firstname} ${c.cr_lastname}`,
          email: c.cr_email,
          status: getStatusLabel(c.cr_status),
          statusCode: c.cr_status,
          idType: getIdTypeLabel(c.cr_idtype),
          idNumber: c.cr_idnumber,
          createdOn: c.createdon,
        }));

        console.log(`[Tool] list_customers returning ${customers.length} customers`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(customers, null, 2),
            },
          ],
        };
      } catch (error) {
        console.error(`[Tool] list_customers error: ${error.message}`);
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      }
    }
  );

  // --------------------------------------------------------------------------
  // TOOL: Get Customer Details
  // --------------------------------------------------------------------------
  mcpServer.tool(
    "get_customer",
    "Get detailed information about a specific KYC customer by name or ID.",
    {
      customerId: z.string().optional().describe("The customer GUID ID"),
      customerName: z.string().optional().describe("The customer name to search for (partial match supported)"),
    },
    async ({ customerId, customerName }) => {
      console.log(`[Tool] get_customer called with customerId=${customerId}, customerName=${customerName}`);
      try {
        let customer;

        if (customerId) {
          customer = await callDataverse(`cr_kyccustomers(${customerId})`);
        } else if (customerName) {
          const result = await callDataverse(
            `cr_kyccustomers?$filter=contains(cr_fullname,'${customerName}') or contains(cr_firstname,'${customerName}') or contains(cr_lastname,'${customerName}')`
          );
          if (result.value.length === 0) {
            return {
              content: [{ type: "text", text: `No customer found matching "${customerName}"` }],
            };
          }
          customer = result.value[0];
        } else {
          return {
            content: [{ type: "text", text: "Please provide either customerId or customerName" }],
          };
        }

        const formatted = {
          id: customer.cr_kyccustomerid,
          fullName: customer.cr_fullname || `${customer.cr_firstname} ${customer.cr_lastname}`,
          firstName: customer.cr_firstname,
          lastName: customer.cr_lastname,
          email: customer.cr_email,
          dateOfBirth: customer.cr_dateofbirth,
          address: customer.cr_address,
          city: customer.cr_city,
          country: customer.cr_country,
          idType: getIdTypeLabel(customer.cr_idtype),
          idNumber: customer.cr_idnumber,
          status: getStatusLabel(customer.cr_status),
          statusCode: customer.cr_status,
          createdOn: customer.createdon,
          modifiedOn: customer.modifiedon,
        };

        console.log(`[Tool] get_customer returning customer: ${formatted.fullName}`);
        return {
          content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
        };
      } catch (error) {
        console.error(`[Tool] get_customer error: ${error.message}`);
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      }
    }
  );

  // --------------------------------------------------------------------------
  // TOOL: Get Customer Documents
  // --------------------------------------------------------------------------
  mcpServer.tool(
    "get_customer_documents",
    "List all documents uploaded for a specific customer.",
    {
      customerId: z.string().describe("The customer GUID ID (required)"),
    },
    async ({ customerId }) => {
      console.log(`[Tool] get_customer_documents called with customerId=${customerId}`);
      try {
        if (!customerId) {
          return {
            content: [{ type: "text", text: "customerId is required" }],
          };
        }

        const result = await callDataverse(
          `cr_kycdocuments?$filter=_cr_customerid_value eq ${customerId}&$select=cr_kycdocumentid,cr_name,cr_filename,cr_documenttype,cr_filesize,cr_mimetype,cr_status,createdon&$orderby=createdon desc`
        );

        const documents = result.value.map((d) => ({
          id: d.cr_kycdocumentid,
          name: d.cr_name || d.cr_filename,
          filename: d.cr_filename,
          documentType: getDocTypeLabel(d.cr_documenttype),
          documentTypeCode: d.cr_documenttype,
          fileSize: d.cr_filesize,
          mimeType: d.cr_mimetype,
          status: getDocStatusLabel(d.cr_status),
          statusCode: d.cr_status,
          uploadedOn: d.createdon,
        }));

        console.log(`[Tool] get_customer_documents returning ${documents.length} documents`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  customerId,
                  documentCount: documents.length,
                  documents,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        console.error(`[Tool] get_customer_documents error: ${error.message}`);
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      }
    }
  );

  // --------------------------------------------------------------------------
  // TOOL: Read Document Content (Extract Text)
  // --------------------------------------------------------------------------
  mcpServer.tool(
    "read_document_content",
    "Extract and read the text content from a KYC document. Uses Azure Document Intelligence for PDF/image OCR. You can provide either the document GUID ID or the filename.",
    {
      documentId: z.string().optional().describe("The document GUID ID"),
      filename: z.string().optional().describe("The document filename to search for"),
    },
    async ({ documentId, filename }) => {
      console.log(`[Tool] read_document_content called with documentId=${documentId}, filename=${filename}`);
      if (!documentId && !filename) {
        return {
          content: [{ type: "text", text: "Either documentId or filename is required" }],
        };
      }

      let document;
      
      // If we have a documentId that looks like a GUID, use direct lookup
      const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (documentId && guidPattern.test(documentId)) {
        // Get document with file content by GUID
        document = await callDataverse(
          `cr_kycdocuments(${documentId})?$select=cr_kycdocumentid,cr_name,cr_filename,cr_documenttype,cr_mimetype,cr_filecontent`
        );
      } else {
        // Search by filename (documentId might contain filename, or use explicit filename param)
        const searchName = filename || documentId;
        console.log(`[Tool] read_document_content searching by filename: ${searchName}`);
        const result = await callDataverse(
          `cr_kycdocuments?$filter=contains(cr_filename,'${searchName}') or contains(cr_name,'${searchName}')&$select=cr_kycdocumentid,cr_name,cr_filename,cr_documenttype,cr_mimetype,cr_filecontent&$top=1`
        );
        if (!result.value || result.value.length === 0) {
          return {
            content: [{ type: "text", text: `No document found matching "${searchName}"` }],
          };
        }
        document = result.value[0];
      }

      if (!document.cr_filecontent) {
        return {
          content: [{ type: "text", text: "No file content found for this document" }],
        };
      }

      try {
        // Extract text using Azure Document Intelligence
        const extracted = await extractTextFromDocument(
          document.cr_filecontent,
          document.cr_mimetype
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  documentId,
                  filename: document.cr_filename || document.cr_name,
                  documentType: getDocTypeLabel(document.cr_documenttype),
                  mimeType: document.cr_mimetype,
                  pageCount: extracted.pageCount,
                  extractedText: extracted.content,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error extracting text from document: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  // --------------------------------------------------------------------------
  // TOOL: Update Customer Status
  // --------------------------------------------------------------------------
  mcpServer.tool(
    "update_customer_status",
    "Update the KYC status of a customer after document evaluation.",
    {
      customerId: z.string().describe("The customer GUID ID (required)"),
      status: z.number().describe("New status: 1=Pending, 2=Under Review, 3=Approved, 4=Rejected (required)"),
    },
    async ({ customerId, status }) => {
      console.log(`[Tool] update_customer_status called with customerId=${customerId}, status=${status}`);
      if (!customerId || !status) {
        return {
          content: [{ type: "text", text: "customerId and status are required" }],
        };
      }

      if (status < 1 || status > 4) {
        return {
          content: [{ type: "text", text: "status must be 1 (Pending), 2 (Under Review), 3 (Approved), or 4 (Rejected)" }],
        };
      }

      await callDataverse(`cr_kyccustomers(${customerId})`, "PATCH", {
        cr_status: status,
      });

      return {
        content: [
          {
            type: "text",
            text: `Customer status updated to "${getStatusLabel(status)}" successfully.`,
          },
        ],
      };
    }
  );

  // --------------------------------------------------------------------------
  // TOOL: Get KYC Summary
  // --------------------------------------------------------------------------
  mcpServer.tool(
    "get_kyc_summary",
    "Get a summary of KYC applications including counts by status.",
    {},
    async () => {
      console.log(`[Tool] get_kyc_summary called`);
      const result = await callDataverse(
        "cr_kyccustomers?$select=cr_kyccustomerid,cr_status"
      );

      const customers = result.value;
      const summary = {
        totalCustomers: customers.length,
        byStatus: {
          pending: customers.filter((c) => c.cr_status === 1).length,
          underReview: customers.filter((c) => c.cr_status === 2).length,
          approved: customers.filter((c) => c.cr_status === 3).length,
          rejected: customers.filter((c) => c.cr_status === 4).length,
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  // --------------------------------------------------------------------------
  // TOOL: Search Company (GLEIF)
  // --------------------------------------------------------------------------
  mcpServer.tool(
    "search_company",
    "Search for a company in the GLEIF database by name. Returns LEI (Legal Entity Identifier), legal name, address, jurisdiction, and registration status. Use this to verify if a legal entity exists and get official registry information.",
    {
      companyName: z.string().describe("The company name to search for"),
    },
    async ({ companyName }) => {
      console.log(`[Tool] search_company called with companyName=${companyName}`);
      try {
        const url = `https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=${encodeURIComponent(companyName)}&page[size]=5`;
        const response = await fetch(url, {
          headers: { Accept: "application/vnd.api+json" },
        });

        if (!response.ok) {
          throw new Error(`GLEIF API error: ${response.status}`);
        }

        const data = await response.json();
        const results = (data.data || []).map((record) => ({
          lei: record.attributes.lei,
          legalName: record.attributes.entity?.legalName?.name,
          otherNames: record.attributes.entity?.otherNames?.map((n) => n.name) || [],
          legalAddress: {
            addressLines: record.attributes.entity?.legalAddress?.addressLines,
            city: record.attributes.entity?.legalAddress?.city,
            country: record.attributes.entity?.legalAddress?.country,
            postalCode: record.attributes.entity?.legalAddress?.postalCode,
          },
          jurisdiction: record.attributes.entity?.jurisdiction,
          status: record.attributes.entity?.status,
          registrationStatus: record.attributes.registration?.status,
          lastUpdate: record.attributes.registration?.lastUpdateDate,
        }));

        console.log(`[Tool] search_company found ${results.length} results`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query: companyName,
                  resultCount: results.length,
                  companies: results,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        console.error(`[Tool] search_company error: ${error.message}`);
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      }
    }
  );

  // --------------------------------------------------------------------------
  // TOOL: Verify LEI
  // --------------------------------------------------------------------------
  mcpServer.tool(
    "verify_lei",
    "Verify a Legal Entity Identifier (LEI) code against the GLEIF database. Returns entity details and validates if the LEI is active, expired, or invalid. LEI is a 20-character alphanumeric code.",
    {
      leiCode: z.string().describe("The 20-character LEI code to verify"),
    },
    async ({ leiCode }) => {
      console.log(`[Tool] verify_lei called with leiCode=${leiCode}`);
      try {
        // Validate LEI format
        if (!/^[A-Z0-9]{20}$/.test(leiCode)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    lei: leiCode,
                    valid: false,
                    error: "Invalid LEI format. LEI must be exactly 20 alphanumeric characters.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const url = `https://api.gleif.org/api/v1/lei-records/${leiCode}`;
        const response = await fetch(url, {
          headers: { Accept: "application/vnd.api+json" },
        });

        if (response.status === 404) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    lei: leiCode,
                    valid: false,
                    error: "LEI not found in GLEIF database.",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        if (!response.ok) {
          throw new Error(`GLEIF API error: ${response.status}`);
        }

        const data = await response.json();
        const record = data.data;
        const entity = record.attributes.entity;
        const registration = record.attributes.registration;

        const result = {
          lei: leiCode,
          valid: true,
          legalName: entity?.legalName?.name,
          status: entity?.status,
          registrationStatus: registration?.status,
          jurisdiction: entity?.jurisdiction,
          legalAddress: {
            addressLines: entity?.legalAddress?.addressLines,
            city: entity?.legalAddress?.city,
            country: entity?.legalAddress?.country,
            postalCode: entity?.legalAddress?.postalCode,
          },
          initialRegistrationDate: registration?.initialRegistrationDate,
          lastUpdateDate: registration?.lastUpdateDate,
          nextRenewalDate: registration?.nextRenewalDate,
          managingLou: registration?.managingLou,
        };

        console.log(`[Tool] verify_lei found: ${result.legalName}`);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        console.error(`[Tool] verify_lei error: ${error.message}`);
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      }
    }
  );

  // --------------------------------------------------------------------------
  // TOOL: Screen Adverse Media (Perplexity)
  // --------------------------------------------------------------------------
  mcpServer.tool(
    "screen_adverse_media",
    "Screen a company or individual for adverse media, sanctions, fraud allegations, lawsuits, and regulatory issues. Uses Perplexity AI to search and synthesize findings from public sources. Essential for KYC due diligence.",
    {
      entityName: z.string().describe("The company or person name to screen"),
      entityType: z.enum(["company", "person"]).optional().describe("Whether this is a company or person (default: company)"),
    },
    async ({ entityName, entityType = "company" }) => {
      console.log(`[Tool] screen_adverse_media called for ${entityType}: ${entityName}`);

      if (!PERPLEXITY_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Perplexity API key not configured. Cannot perform adverse media screening.",
            },
          ],
        };
      }

      try {
        const prompt = `Search for any negative news, sanctions, fraud allegations, lawsuits, regulatory actions, or controversies involving ${entityName}. Focus on:
1. Sanctions lists (OFAC, EU, UN)
2. Fraud or financial crimes
3. Regulatory fines or enforcement actions
4. Lawsuits or legal proceedings
5. Money laundering allegations
6. Politically exposed persons (PEP) connections
7. Negative press coverage

Provide a summary with sources. If nothing negative found, state that clearly.`;

        const response = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "sonar",
            messages: [
              {
                role: "system",
                content:
                  "You are a KYC compliance analyst performing adverse media screening. Be thorough but factual. Always cite sources when available.",
              },
              {
                role: "user",
                content: prompt,
              },
            ],
            temperature: 0.1,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Perplexity API error: ${response.status} - ${error}`);
        }

        const data = await response.json();
        const screeningResult = data.choices?.[0]?.message?.content || "No results returned";
        const citations = data.citations || [];

        // Check for red flags in the response
        const lowerResult = screeningResult.toLowerCase();
        const hasRedFlags =
          lowerResult.includes("sanction") ||
          lowerResult.includes("fraud") ||
          lowerResult.includes("money laundering") ||
          lowerResult.includes("indicted") ||
          lowerResult.includes("convicted") ||
          lowerResult.includes("regulatory action") ||
          lowerResult.includes("fine") ||
          lowerResult.includes("penalty");

        const result = {
          entityName,
          entityType,
          screeningResult,
          sources: citations,
          hasRedFlags,
          screenedAt: new Date().toISOString(),
        };

        console.log(`[Tool] screen_adverse_media completed. Red flags: ${hasRedFlags}`);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        console.error(`[Tool] screen_adverse_media error: ${error.message}`);
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      }
    }
  );

  // --------------------------------------------------------------------------
  // TOOL: Run Legal Entity KYC (Combined)
  // --------------------------------------------------------------------------
  mcpServer.tool(
    "run_legal_entity_kyc",
    "Run a comprehensive KYC check on a legal entity. This tool performs: 1) GLEIF search to verify company exists, 2) LEI validation if provided, 3) Adverse media screening. Returns a complete KYC assessment with risk flags.",
    {
      companyName: z.string().describe("The company name to verify"),
      leiCode: z.string().optional().describe("Optional LEI code to verify (20 characters)"),
    },
    async ({ companyName, leiCode }) => {
      console.log(`[Tool] run_legal_entity_kyc called for: ${companyName}`);
      const results = {
        companyName,
        timestamp: new Date().toISOString(),
        checks: {},
        overallRisk: "LOW",
        riskFactors: [],
      };

      // Step 1: GLEIF Search
      try {
        const gleifUrl = `https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=${encodeURIComponent(companyName)}&page[size]=3`;
        const gleifResponse = await fetch(gleifUrl, {
          headers: { Accept: "application/vnd.api+json" },
        });

        if (gleifResponse.ok) {
          const gleifData = await gleifResponse.json();
          const matches = gleifData.data || [];
          results.checks.gleifSearch = {
            status: "completed",
            matchCount: matches.length,
            matches: matches.map((m) => ({
              lei: m.attributes.lei,
              legalName: m.attributes.entity?.legalName?.name,
              status: m.attributes.entity?.status,
              jurisdiction: m.attributes.entity?.jurisdiction,
            })),
          };

          if (matches.length === 0) {
            results.riskFactors.push("Company not found in GLEIF registry");
          }
        } else {
          results.checks.gleifSearch = { status: "error", error: `HTTP ${gleifResponse.status}` };
        }
      } catch (error) {
        results.checks.gleifSearch = { status: "error", error: error.message };
      }

      // Step 2: LEI Verification (if provided)
      if (leiCode) {
        try {
          const leiUrl = `https://api.gleif.org/api/v1/lei-records/${leiCode}`;
          const leiResponse = await fetch(leiUrl, {
            headers: { Accept: "application/vnd.api+json" },
          });

          if (leiResponse.ok) {
            const leiData = await leiResponse.json();
            const entity = leiData.data.attributes.entity;
            const registration = leiData.data.attributes.registration;

            results.checks.leiVerification = {
              status: "completed",
              valid: true,
              legalName: entity?.legalName?.name,
              entityStatus: entity?.status,
              registrationStatus: registration?.status,
              nextRenewalDate: registration?.nextRenewalDate,
            };

            if (registration?.status !== "ISSUED") {
              results.riskFactors.push(`LEI registration status: ${registration?.status}`);
            }
          } else if (leiResponse.status === 404) {
            results.checks.leiVerification = { status: "completed", valid: false, error: "LEI not found" };
            results.riskFactors.push("Provided LEI not found in GLEIF database");
          } else {
            results.checks.leiVerification = { status: "error", error: `HTTP ${leiResponse.status}` };
          }
        } catch (error) {
          results.checks.leiVerification = { status: "error", error: error.message };
        }
      }

      // Step 3: Adverse Media Screening
      if (PERPLEXITY_API_KEY) {
        try {
          const prompt = `Search for any negative news, sanctions, fraud, lawsuits, or regulatory issues involving ${companyName}. Be concise.`;
          const perplexityResponse = await fetch("https://api.perplexity.ai/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "sonar",
              messages: [
                { role: "system", content: "You are a KYC compliance analyst. Be factual and concise." },
                { role: "user", content: prompt },
              ],
              temperature: 0.1,
            }),
          });

          if (perplexityResponse.ok) {
            const perplexityData = await perplexityResponse.json();
            const screening = perplexityData.choices?.[0]?.message?.content || "";
            const lowerScreening = screening.toLowerCase();
            const hasRedFlags =
              lowerScreening.includes("sanction") ||
              lowerScreening.includes("fraud") ||
              lowerScreening.includes("money laundering") ||
              lowerScreening.includes("convicted");

            results.checks.adverseMedia = {
              status: "completed",
              summary: screening,
              hasRedFlags,
              sources: perplexityData.citations || [],
            };

            if (hasRedFlags) {
              results.riskFactors.push("Adverse media findings detected");
            }
          } else {
            results.checks.adverseMedia = { status: "error", error: `HTTP ${perplexityResponse.status}` };
          }
        } catch (error) {
          results.checks.adverseMedia = { status: "error", error: error.message };
        }
      } else {
        results.checks.adverseMedia = { status: "skipped", reason: "Perplexity API key not configured" };
      }

      // Calculate overall risk
      if (results.riskFactors.length >= 3) {
        results.overallRisk = "HIGH";
      } else if (results.riskFactors.length >= 1) {
        results.overallRisk = "MEDIUM";
      } else {
        results.overallRisk = "LOW";
      }

      console.log(`[Tool] run_legal_entity_kyc completed. Risk: ${results.overallRisk}`);
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  // --------------------------------------------------------------------------
  // RESOURCE: KYC Verification Guidelines
  // --------------------------------------------------------------------------
  mcpServer.resource(
    "kyc-guidelines",
    "kyc://guidelines/verification",
    {
      description: "KYC verification guidelines and rules for document evaluation",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "kyc://guidelines/verification",
          mimeType: "text/markdown",
          text: `# KYC Verification Guidelines

## Document Requirements

### ID Documents (Required)
- Must be government-issued (Passport, National ID, or Driver's License)
- Must show full legal name matching the application
- Must show date of birth matching the application
- Must be valid (not expired)
- Photo must be clearly visible

### Proof of Address (Required)
- Must be dated within the last 3 months
- Acceptable documents: utility bill, bank statement, government letter
- Must show full name and residential address
- Must match the address provided in the application

### Income Statement (Optional but recommended)
- Recent payslip, tax return, or employment letter
- Should verify stated occupation and income level

## Verification Process

1. **Check ID Document**: Verify name, DOB, and expiry date
2. **Check Proof of Address**: Verify address matches and document is recent
3. **Cross-Reference**: Ensure all documents show consistent information
4. **Risk Assessment**: Flag any discrepancies or suspicious patterns

## Status Decisions

- **Approve**: All documents valid, information consistent, no red flags
- **Reject**: Fraudulent documents, major discrepancies, or failed verification
- **Under Review**: Missing documents, minor discrepancies needing clarification

## Red Flags
- Mismatched names across documents
- Expired ID documents
- Proof of address older than 3 months
- Inconsistent addresses
- Signs of document tampering
`,
        },
      ],
    })
  );

  return mcpServer;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getStatusLabel(status) {
  const labels = { 1: "Pending", 2: "Under Review", 3: "Approved", 4: "Rejected" };
  return labels[status] || "Unknown";
}

function getIdTypeLabel(type) {
  const labels = { 1: "Passport", 2: "National ID", 3: "Driver's License" };
  return labels[type] || "Unknown";
}

function getDocTypeLabel(type) {
  const labels = { 1: "ID Document", 2: "Proof of Address", 3: "Income Statement", 4: "Other" };
  return labels[type] || "Unknown";
}

function getDocStatusLabel(status) {
  const labels = { 1: "Uploaded", 2: "Verified", 3: "Rejected" };
  return labels[status] || "Unknown";
}

// ============================================================================
// EXPRESS SERVER FOR MCP (Streamable HTTP Transport)
// ============================================================================

const app = express();

// ============================================================================
// API KEY AUTHENTICATION MIDDLEWARE
// ============================================================================

function validateApiKey(req, res, next) {
  if (!API_KEY) {
    return next();
  }

  const providedKey =
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace("Bearer ", "") ||
    req.query.api_key;

  if (!providedKey) {
    console.log(`[Auth] Rejected - No API key provided from ${req.ip}`);
    return res.status(401).json({
      error: "Unauthorized",
      message: "API key required. Provide via x-api-key header, Authorization: Bearer header, or api_key query parameter",
    });
  }

  if (providedKey !== API_KEY) {
    console.log(`[Auth] Rejected - Invalid API key from ${req.ip}`);
    return res.status(403).json({
      error: "Forbidden",
      message: "Invalid API key",
    });
  }

  next();
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    secured: !!API_KEY,
    dataverseConfigured: !!(DATAVERSE_CLIENT_ID && DATAVERSE_CLIENT_SECRET),
    docIntelligenceConfigured: !!DOC_INTELLIGENCE_KEY,
  });
});

// Test Dataverse connectivity
app.get("/test-dataverse", validateApiKey, async (req, res) => {
  try {
    const startTime = Date.now();
    const result = await callDataverse("cr_kyccustomers?$top=1");
    const duration = Date.now() - startTime;

    res.json({
      success: true,
      message: "Successfully connected to Dataverse",
      duration: `${duration}ms`,
      endpoint: DATAVERSE_URL,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to connect to Dataverse",
      error: error.message,
    });
  }
});

// ============================================================================
// MCP ENDPOINT (Streamable HTTP Transport)
// ============================================================================

const streamableTransports = new Map();

app.post("/mcp", validateApiKey, express.json(), async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  console.log(`[MCP] POST /mcp (session: ${sessionId || "new"}, method: ${req.body?.method || "unknown"})`);

  try {
    if (sessionId && streamableTransports.has(sessionId)) {
      const transport = streamableTransports.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (newSessionId) => {
          console.log(`[MCP] Session initialized: ${newSessionId}`);
          streamableTransports.set(newSessionId, transport);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && streamableTransports.has(sid)) {
          console.log(`[MCP] Session closed: ${sid}`);
          streamableTransports.delete(sid);
        }
      };

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
  } catch (error) {
    console.error("[MCP] Error handling request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", validateApiKey, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (!sessionId || !streamableTransports.has(sessionId)) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: Invalid or missing session ID" },
      id: null,
    });
    return;
  }

  const transport = streamableTransports.get(sessionId);
  await transport.handleRequest(req, res);
});

app.delete("/mcp", validateApiKey, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (!sessionId || !streamableTransports.has(sessionId)) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: Invalid or missing session ID" },
      id: null,
    });
    return;
  }

  try {
    const transport = streamableTransports.get(sessionId);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("[MCP] Error handling session termination:", error);
    if (!res.headersSent) {
      res.status(500).send("Error processing session termination");
    }
  }
});

// Info endpoint
app.get("/", (req, res) => {
  res.json({
    name: "KYC MCP Server",
    version: "1.0.0",
    description: "MCP Server for KYC document evaluation - connects Copilot Studio to Dataverse and Azure Document Intelligence",
    endpoints: {
      mcp: "/mcp (Streamable HTTP)",
      health: "/health",
      testDataverse: "/test-dataverse",
    },
    tools: [
      "list_customers - List all KYC customers",
      "get_customer - Get customer details by ID or name",
      "get_customer_documents - List documents for a customer",
      "read_document_content - Extract text from a document using Azure Document Intelligence",
      "update_customer_status - Update customer KYC status",
      "get_kyc_summary - Get summary statistics",
    ],
  });
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║              KYC MCP SERVER - RUNNING                          ║
╠═══════════════════════════════════════════════════════════════╣
║  URL: http://0.0.0.0:${PORT}                                       ║
║  MCP Endpoint: POST /mcp (Streamable HTTP)                    ║
║  Security: ${API_KEY ? "API KEY REQUIRED ✓" : "⚠️  NOT SECURED"}                               ║
║  Dataverse: ${DATAVERSE_URL.substring(0, 35)}...              ║
║  Doc Intelligence: ${DOC_INTELLIGENCE_KEY ? "CONFIGURED ✓" : "NOT CONFIGURED"}                         ║
║  Tools: 6                                                     ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

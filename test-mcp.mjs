import http from "http";

// Set these environment variables before running:
// MCP_API_KEY - Your MCP server API key
// MCP_SERVER_URL - Your MCP server URL (e.g., https://your-server.azurecontainerapps.io)
const API_KEY = process.env.MCP_API_KEY || "your-api-key";
const BASE_URL = process.env.MCP_SERVER_URL || "http://localhost:8080";

async function testMcp() {
  // Initialize session
  const initResp = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } },
      id: 1
    })
  });
  const initData = await initResp.json();
  const sessionId = initResp.headers.get("mcp-session-id");
  console.log("Session:", sessionId);
  console.log("Init:", JSON.stringify(initData, null, 2));

  // List tools
  const toolsResp = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json", "mcp-session-id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
      id: 2
    })
  });
  const toolsData = await toolsResp.text();
  console.log("Tools:", toolsData);
}

testMcp().catch(console.error);

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "test", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3456/mcp")));
  console.log("Connected!");
  const tools = await client.listTools();
  console.log("Tools:", tools.tools.map(t => t.name));
  await client.close();
} catch (err) {
  console.error("Error:", err);
}
process.exit(0);

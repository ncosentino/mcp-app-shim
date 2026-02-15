#!/usr/bin/env node

/**
 * Test MCP server that registers both a normal tool and an app tool.
 * Used to validate the mcp-app-shim proxy.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const app = express();
app.use(express.json());

const WIDGET_HTML = `<!DOCTYPE html>
<html>
<head><title>Test Widget</title></head>
<body>
  <h1 id="title">Loading...</h1>
  <script>
    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.method === 'ui/initialize') {
        window.parent.postMessage({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '0.1.0' } }, '*');
      }
      if (msg.method === 'ui/notifications/tool-input') {
        document.getElementById('title').textContent = msg.params.arguments.title || 'No title';
      }
      if (msg.method === 'ui/notifications/tool-result') {
        document.getElementById('title').textContent += ' (done)';
      }
    });
  </script>
</body>
</html>`;

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "test-mcp-server",
    version: "1.0.0",
  });

  server.registerTool(
    "echo",
    {
      description: "Echoes back the input",
      inputSchema: { message: z.string() },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `Echo: ${message}` }],
    }),
  );

  server.registerTool(
    "show_widget",
    {
      description: "Shows a test widget",
      inputSchema: { title: z.string() },
      _meta: {
        ui: { resourceUri: "ui://test/widget.html" },
        "ui/resourceUri": "ui://test/widget.html",
      },
    },
    async ({ title }) => ({
      content: [{ type: "text", text: `Widget created: ${title}` }],
    }),
  );

  server.registerResource(
    "Test Widget",
    "ui://test/widget.html",
    { mimeType: "text/html;profile=mcp-app" },
    async () => ({
      contents: [{
        uri: "ui://test/widget.html",
        mimeType: "text/html;profile=mcp-app",
        text: WIDGET_HTML,
      }],
    }),
  );

  return server;
}

// Set up Streamable HTTP transport — new McpServer per session
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) delete transports[sid];
    };

    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: Server not initialized" },
    id: null,
  });
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
    return;
  }
  res.status(400).send("No session");
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res);
    return;
  }
  res.status(400).send("No session");
});

const httpServer = createServer(app);
httpServer.listen(3456, () => {
  console.log("Test MCP server running at http://localhost:3456/mcp");
});

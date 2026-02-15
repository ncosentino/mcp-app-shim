#!/usr/bin/env node

/**
 * MCP App Shim — stdio MCP proxy that opens a browser for MCP App tools.
 *
 * Usage: mcp-app-shim <upstream-mcp-url>
 *
 * Connects to the upstream MCP server via HTTP, re-exposes all tools via stdio,
 * and when a tool has _meta.ui.resourceUri, serves the app HTML locally and
 * opens the user's browser.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startAppHostServer, type AppHostServer } from "./app-host-server.js";

const IMPLEMENTATION = { name: "mcp-app-shim", version: "0.1.0" };

function getToolUiResourceUri(tool: Tool): string | undefined {
  const meta = tool._meta as Record<string, unknown> | undefined;
  if (!meta) return undefined;
  const ui = meta.ui as { resourceUri?: string } | undefined;
  if (ui?.resourceUri) return ui.resourceUri;
  return meta["ui/resourceUri"] as string | undefined;
}

function log(...args: unknown[]) {
  process.stderr.write(`[mcp-app-shim] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`);
}

async function connectToUpstream(url: URL): Promise<Client> {
  try {
    const client = new Client(IMPLEMENTATION);
    await client.connect(new StreamableHTTPClientTransport(url));
    log("Connected via Streamable HTTP");
    return client;
  } catch {
    log("Streamable HTTP failed, trying SSE...");
  }

  try {
    const client = new Client(IMPLEMENTATION);
    await client.connect(new SSEClientTransport(url));
    log("Connected via SSE");
    return client;
  } catch (err) {
    throw new Error(`Could not connect to upstream: ${err}`);
  }
}

async function main() {
  const upstreamUrl = process.argv[2];
  if (!upstreamUrl) {
    process.stderr.write("Usage: mcp-app-shim <upstream-mcp-url>\n");
    process.exit(1);
  }

  log("Connecting to upstream:", upstreamUrl);
  const upstream = await connectToUpstream(new URL(upstreamUrl));

  // Fetch upstream tools and resources
  const toolsList = await upstream.listTools();
  const tools = new Map<string, Tool>(toolsList.tools.map(t => [t.name, t]));
  log("Discovered tools:", Array.from(tools.keys()));

  let hasResources = false;
  try {
    await upstream.listResources();
    hasResources = true;
    log("Upstream supports resources");
  } catch {
    log("No resources endpoint (ok)");
  }

  let appHostServer: AppHostServer | undefined;

  // Use low-level Server to proxy raw JSON schemas without zod
  const server = new Server(IMPLEMENTATION, {
    capabilities: {
      tools: {},
      ...(hasResources ? { resources: {} } : {}),
    },
  });

  // Proxy listTools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: Array.from(tools.values()) };
  });

  // Proxy callTool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log("Calling upstream tool:", name);

    const result = await upstream.callTool({ name, arguments: args }) as CallToolResult;
    const tool = tools.get(name);
    const uiResourceUri = tool ? getToolUiResourceUri(tool) : undefined;

    if (uiResourceUri) {
      try {
        log("Tool has UI resource:", uiResourceUri);
        const resource = await upstream.readResource({ uri: uiResourceUri });
        const content = resource.contents[0];
        const html = "blob" in content
          ? Buffer.from(content.blob as string, "base64").toString("utf-8")
          : (content as any).text as string;

        if (html) {
          if (!appHostServer) {
            appHostServer = await startAppHostServer(upstream);
          }
          const url = await appHostServer.serveApp(html, args ?? {}, result);
          log("Opened browser:", url);

          const resultContent = Array.isArray(result.content) ? [...result.content] : [];
          resultContent.push({
            type: "text",
            text: `\n\n🖼️ Interactive view opened in browser: ${url}`,
          });
          return { content: resultContent };
        }
      } catch (err) {
        log("Failed to open app UI:", err);
      }
    }

    return result;
  });

  // Proxy listResources
  if (hasResources) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const result = await upstream.listResources();
      return result;
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const result = await upstream.readResource({ uri: request.params.uri });
      return result;
    });
  }

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Stdio MCP server ready");
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});

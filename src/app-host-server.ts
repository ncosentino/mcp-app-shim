/**
 * Local HTTP server that serves MCP App HTML in a browser.
 *
 * Architecture:
 * - Host page on PORT (e.g. 9271) — contains the outer sandbox iframe
 * - Sandbox page on PORT+1 (e.g. 9272) — different origin, loads app HTML in inner iframe
 * - WebSocket on PORT for pushing tool data and proxying callServerTool
 */

import express from "express";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import open from "open";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function log(...args: unknown[]) {
  process.stderr.write(`[app-host] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}\n`);
}

export interface AppHostServer {
  hostPort: number;
  sandboxPort: number;
  serveApp(html: string, toolInput: Record<string, unknown>, toolResult: CallToolResult): Promise<string>;
  close(): void;
}

interface PendingApp {
  html: string;
  toolInput: Record<string, unknown>;
  toolResult: CallToolResult;
}

export async function startAppHostServer(upstream: Client): Promise<AppHostServer> {
  const hostPort = 9271;
  const sandboxPort = 9272;

  // Track pending apps by session ID
  const pendingApps = new Map<string, PendingApp>();
  let sessionCounter = 0;

  // === Host server (serves host page + WebSocket) ===
  const hostApp = express();
  const hostServer = createServer(hostApp);

  // WebSocket server for real-time communication with host page
  const wss = new WebSocketServer({ server: hostServer });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url!, `http://localhost:${hostPort}`);
    const sessionId = url.searchParams.get("session");
    if (!sessionId) {
      ws.close();
      return;
    }

    log("WebSocket connected for session:", sessionId);
    const pending = pendingApps.get(sessionId);
    if (!pending) {
      ws.close();
      return;
    }

    // Send the app data to the browser
    ws.send(JSON.stringify({
      type: "app-data",
      html: pending.html,
      toolInput: pending.toolInput,
      toolResult: pending.toolResult,
      sandboxUrl: `http://localhost:${sandboxPort}/sandbox.html`,
    }));

    // Handle messages from the browser (callServerTool proxying)
    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "call-server-tool") {
          log("Proxying callServerTool:", msg.name);
          const result = await upstream.callTool({
            name: msg.name,
            arguments: msg.arguments,
          });
          ws.send(JSON.stringify({
            type: "tool-result",
            requestId: msg.requestId,
            result,
          }));
        }
      } catch (err) {
        log("WebSocket message error:", err);
      }
    });
  });

  // Serve the host page
  hostApp.get("/app/:sessionId", (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.send(getHostPageHtml(hostPort, sandboxPort));
  });

  // === Sandbox server (different origin for security) ===
  const sandboxApp = express();
  const sandboxServer = createServer(sandboxApp);

  sandboxApp.get("/sandbox.html", (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.setHeader("Content-Security-Policy",
      "default-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https: http:; " +
      "style-src 'self' 'unsafe-inline' blob: data: https: http:; " +
      "img-src 'self' data: blob: https: http:; " +
      "font-src 'self' data: blob: https: http:; " +
      "connect-src 'self' https: http: ws: wss:; " +
      "worker-src 'self' blob: https: http:; " +
      "frame-src 'none'; " +
      "object-src 'none'; " +
      "base-uri 'none'"
    );
    res.send(getSandboxPageHtml());
  });

  // Start both servers
  await new Promise<void>((resolve) => hostServer.listen(hostPort, resolve));
  await new Promise<void>((resolve) => sandboxServer.listen(sandboxPort, resolve));
  log(`Host server: http://localhost:${hostPort}`);
  log(`Sandbox server: http://localhost:${sandboxPort}`);

  return {
    hostPort,
    sandboxPort,
    async serveApp(html, toolInput, toolResult) {
      const sessionId = String(++sessionCounter);
      pendingApps.set(sessionId, { html, toolInput, toolResult });

      const url = `http://localhost:${hostPort}/app/${sessionId}`;
      await open(url);
      return url;
    },
    close() {
      hostServer.close();
      sandboxServer.close();
    },
  };
}

function getHostPageHtml(hostPort: number, sandboxPort: number): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light dark">
  <title>MCP App Viewer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100vh; width: 100vw; font-family: system-ui, sans-serif; }
    body { display: flex; flex-direction: column; background: #f5f5f5; }
    @media (prefers-color-scheme: dark) { body { background: #1a1a2e; color: #eee; } }
    #status { padding: 8px 16px; font-size: 14px; color: #666; }
    #sandbox-frame {
      flex: 1; width: 100%; border: none;
    }
  </style>
</head>
<body>
  <div id="status">Connecting...</div>
  <iframe id="sandbox-frame"></iframe>

  <script>
    const sessionId = window.location.pathname.split('/').pop();
    const SANDBOX_PROXY_READY = "ui/notifications/sandbox-proxy-ready";
    const SANDBOX_RESOURCE_READY = "ui/notifications/sandbox-resource-ready";

    const frame = document.getElementById('sandbox-frame');
    const status = document.getElementById('status');

    // Connect WebSocket to get app data
    const ws = new WebSocket('ws://localhost:${hostPort}/?session=' + sessionId);
    let appData = null;
    let pendingToolCalls = new Map();
    let toolCallCounter = 0;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'app-data') {
        appData = msg;
        status.textContent = 'Loading app...';

        // Load the sandbox iframe (different origin for security)
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
        frame.src = msg.sandboxUrl;
      }

      if (msg.type === 'tool-result') {
        const resolve = pendingToolCalls.get(msg.requestId);
        if (resolve) {
          resolve(msg.result);
          pendingToolCalls.delete(msg.requestId);
        }
      }
    };

    // Listen for messages from sandbox iframe
    window.addEventListener('message', (event) => {
      // Sandbox proxy ready — send it the app HTML
      if (event.data && event.data.method === SANDBOX_PROXY_READY) {
        status.textContent = 'Initializing app...';
        // Send the HTML to the sandbox
        frame.contentWindow.postMessage({
          jsonrpc: '2.0',
          method: SANDBOX_RESOURCE_READY,
          params: { html: appData.html },
        }, '*');
        return;
      }

      // Handle JSON-RPC from the app (via sandbox relay)
      if (event.data && event.data.jsonrpc === '2.0') {
        handleAppMessage(event.data);
      }
    });

    // Minimal AppBridge host-side protocol handler
    function handleAppMessage(msg) {
      const method = msg.method;
      const id = msg.id;

      // ui/initialize — app is ready for handshake
      if (method === 'ui/initialize') {
        status.textContent = 'App connected!';
        setTimeout(() => { status.style.display = 'none'; }, 1000);

        // Send initialize response (must match McpUiInitializeResultSchema)
        sendToApp({
          jsonrpc: '2.0',
          id: id,
          result: {
            protocolVersion: msg.params?.protocolVersion || '2025-11-21',
            hostInfo: {
              name: 'mcp-app-shim',
              version: '0.1.0',
            },
            hostCapabilities: {
              serverTools: {},
              openLinks: {},
            },
            hostContext: {
              theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
              platform: 'web',
              containerDimensions: { maxHeight: window.innerHeight - 40 },
              displayMode: 'inline',
              availableDisplayModes: ['inline'],
            },
          },
        });

        // Send tool input
        sendToApp({
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-input',
          params: { arguments: appData.toolInput },
        });

        // Send tool result
        sendToApp({
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: appData.toolResult,
        });

        return;
      }

      // tools/call — app wants to call a server tool
      if (method === 'tools/call') {
        const requestId = String(++toolCallCounter);
        const promise = new Promise((resolve) => {
          pendingToolCalls.set(requestId, resolve);
        });

        ws.send(JSON.stringify({
          type: 'call-server-tool',
          requestId,
          name: msg.params.name,
          arguments: msg.params.arguments,
        }));

        promise.then((result) => {
          sendToApp({
            jsonrpc: '2.0',
            id: id,
            result: result,
          });
        });

        return;
      }

      // ui/sizeChange — app reporting its size
      if (method === 'ui/sizeChange') {
        const { width, height } = msg.params || {};
        if (height) frame.style.height = height + 'px';
        if (width) frame.style.minWidth = Math.min(width, window.innerWidth) + 'px';
        if (id) sendToApp({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      // ui/openLink
      if (method === 'ui/openLink') {
        window.open(msg.params.url, '_blank', 'noopener,noreferrer');
        if (id) sendToApp({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      // ui/message, ui/updateModelContext, logging — acknowledge
      if (id) {
        sendToApp({ jsonrpc: '2.0', id, result: {} });
      }
    }

    function sendToApp(msg) {
      frame.contentWindow.postMessage(msg, '*');
    }
  </script>
</body>
</html>`;
}

function getSandboxPageHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light dark">
  <title>MCP App Sandbox</title>
  <style>
    html, body { margin: 0; height: 100vh; width: 100vw; background: transparent; }
    body { display: flex; flex-direction: column; }
    iframe { border: none; flex: 1; width: 100%; background: transparent; }
  </style>
</head>
<body>
  <script>
    if (window.self === window.top) {
      throw new Error("Sandbox must run in an iframe");
    }

    const RESOURCE_READY = "ui/notifications/sandbox-resource-ready";
    const PROXY_READY = "ui/notifications/sandbox-proxy-ready";

    // Create inner iframe for the actual app content
    const inner = document.createElement('iframe');
    inner.style = 'width:100%; height:100%; border:none;';
    inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    document.body.appendChild(inner);

    const OWN_ORIGIN = window.location.origin;

    // Relay messages between host (parent) and app (inner iframe)
    window.addEventListener('message', (event) => {
      if (event.source === window.parent) {
        if (event.data && event.data.method === RESOURCE_READY) {
          const { html } = event.data.params;
          const doc = inner.contentDocument || inner.contentWindow?.document;
          if (doc) {
            doc.open();
            doc.write(html);
            doc.close();
          } else {
            inner.srcdoc = html;
          }
        } else {
          // Relay host → app
          if (inner.contentWindow) {
            inner.contentWindow.postMessage(event.data, '*');
          }
        }
      } else if (event.source === inner.contentWindow) {
        // Relay app → host
        window.parent.postMessage(event.data, '*');
      }
    });

    // Notify host that sandbox is ready
    window.parent.postMessage({
      jsonrpc: '2.0',
      method: PROXY_READY,
      params: {},
    }, '*');
  </script>
</body>
</html>`;
}

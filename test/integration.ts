#!/usr/bin/env node

/**
 * Integration test: starts the test server, connects the shim to it,
 * and verifies tools are proxied correctly via MCP stdio protocol.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== MCP App Shim Integration Test ===\n");

  // 1. Start test MCP server
  console.log("1. Starting test MCP server...");
  const testServer = spawn("npx", ["tsx", join(root, "test", "test-server.ts")], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  // Wait for it to start
  await new Promise<void>((resolve) => {
    testServer.stdout!.on("data", (data: Buffer) => {
      const msg = data.toString();
      console.log("   [test-server]", msg.trim());
      if (msg.includes("running at")) resolve();
    });
    testServer.stderr!.on("data", (data: Buffer) => {
      console.error("   [test-server err]", data.toString().trim());
    });
  });

  console.log("   ✓ Test server started\n");

  // 2. Connect to shim via stdio (shim connects to test server)
  console.log("2. Connecting to shim via stdio...");
  const shimTransport = new StdioClientTransport({
    command: "node",
    args: [join(root, "dist", "index.js"), "http://localhost:3456/mcp"],
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(shimTransport);
  console.log("   ✓ Connected to shim\n");

  // 3. List tools — should see both echo and show_widget
  console.log("3. Listing tools...");
  const tools = await client.listTools();
  console.log("   Tools found:", tools.tools.map(t => t.name));

  const hasEcho = tools.tools.some(t => t.name === "echo");
  const hasWidget = tools.tools.some(t => t.name === "show_widget");

  if (!hasEcho) throw new Error("Missing 'echo' tool");
  if (!hasWidget) throw new Error("Missing 'show_widget' tool");
  console.log("   ✓ Both tools proxied correctly\n");

  // 4. Call the echo tool (no UI)
  console.log("4. Calling 'echo' tool...");
  const echoResult = await client.callTool({ name: "echo", arguments: { message: "hello" } });
  const echoText = (echoResult.content as any[])[0]?.text;
  console.log("   Result:", echoText);

  if (echoText !== "Echo: hello") throw new Error(`Unexpected echo result: ${echoText}`);
  console.log("   ✓ Echo tool works\n");

  // 5. Call the show_widget tool (has UI — will try to open browser)
  console.log("5. Calling 'show_widget' tool (app tool)...");
  const widgetResult = await client.callTool({ name: "show_widget", arguments: { title: "Test Widget" } });
  const widgetContent = widgetResult.content as any[];
  console.log("   Result content items:", widgetContent.length);

  const widgetText = widgetContent.map((c: any) => c.text).join("");
  console.log("   Result text:", widgetText.substring(0, 100));

  if (!widgetText.includes("Widget created: Test Widget")) {
    throw new Error(`Unexpected widget result: ${widgetText}`);
  }
  if (widgetText.includes("Interactive view opened")) {
    console.log("   ✓ Browser launch triggered\n");
  } else {
    console.log("   ⚠ Browser launch not detected in result (may be expected if browser open failed)\n");
  }

  // Cleanup
  console.log("6. Cleaning up...");
  await client.close();
  testServer.kill();
  console.log("   ✓ Done\n");

  console.log("=== ALL TESTS PASSED ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ TEST FAILED:", err);
  process.exit(1);
});

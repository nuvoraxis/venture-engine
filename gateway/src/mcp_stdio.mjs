#!/usr/bin/env node
/**
 * Unified Stdio JSON-RPC 2.0 MCP Server for Venture Engine EVM Guard Suite.
 * Exposes all 8 tools (AegisGate, GasPulse, AuditPulse) over stdin/stdout.
 */
import readline from "node:readline";
import { createMcpHttpHandler } from "./mcp_http.mjs";

const LOCAL_STDIO_KEY = process.env.VE_STDIO_LOCAL_KEY || "ve-local-stdio";
const handler = createMcpHttpHandler({
  staticKeys: new Set([LOCAL_STDIO_KEY])
});

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const reqObj = JSON.parse(line);
    const headers = { "Content-Type": "application/json" };
    if (reqObj?.method === "tools/call" && !process.env.VE_REQUIRE_X402_STDIO) {
      headers["X-Api-Key"] = LOCAL_STDIO_KEY;
    }
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(reqObj)
    });
    const resp = await handler(request);
    if (resp.status === 202 || resp.status === 204) return;
    const text = await resp.text();
    if (text.trim()) {
      process.stdout.write(JSON.stringify(JSON.parse(text)) + "\n");
    }
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: err?.message || "Parse error" } }) + "\n"
    );
  }
});

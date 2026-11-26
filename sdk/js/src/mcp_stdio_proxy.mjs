#!/usr/bin/env node
/**
 * Zero-dependency stdio-to-Streamable-HTTP MCP proxy for Venture Engine.
 * Usage:
 *   VENTURE_ENGINE_API_KEY=ve_live_... npx @nuvoraxis/venture-engine-sdk
 *   VENTURE_ENGINE_PAYMENT_TX=0x... npx @nuvoraxis/venture-engine-sdk
 */

import readline from "node:readline";
import { pathToFileURL } from "node:url";

export const DEFAULT_MCP_URL = "https://venture-engine-gateway.leonid-ai-global.workers.dev/mcp";

/**
 * Forward a single JSON-RPC request to the remote Streamable HTTP MCP endpoint.
 */
export async function forwardJsonRpc(message, {
  mcpUrl = DEFAULT_MCP_URL,
  apiKey = "",
  paymentTx = "",
  fetchImpl = fetch
} = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };
  if (apiKey) headers["X-Api-Key"] = apiKey;
  if (paymentTx) headers["X-Payment-Tx"] = paymentTx;

  const res = await fetchImpl(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(message)
  });

  if (res.status === 202 || res.status === 204) {
    return null;
  }

  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

/**
 * Attach a newline-delimited JSON-RPC stdio proxy to input/output streams.
 */
export function createStdioProxy({
  input = process.stdin,
  output = process.stdout,
  mcpUrl = process.env.VENTURE_ENGINE_MCP_URL || DEFAULT_MCP_URL,
  apiKey = process.env.VENTURE_ENGINE_API_KEY || "",
  paymentTx = process.env.VENTURE_ENGINE_PAYMENT_TX || "",
  fetchImpl = fetch
} = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      output.write(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      }) + "\n");
      return;
    }

    const task = (async () => {
      try {
        const reply = await forwardJsonRpc(msg, { mcpUrl, apiKey, paymentTx, fetchImpl });
        if (reply !== null && reply !== undefined) {
          output.write(JSON.stringify(reply) + "\n");
        }
      } catch (err) {
        if (msg && msg.id !== undefined && msg.id !== null) {
          output.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: err?.message || "MCP proxy error" }
          }) + "\n");
        }
      }
    })();

    pending.add(task);
    task.finally(() => pending.delete(task));
  });

  return {
    close: async () => {
      rl.close();
      await Promise.allSettled([...pending]);
    }
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  createStdioProxy();
}

#!/usr/bin/env node
/**
 * AegisGate Stdio MCP Server (JSON-RPC 2.0)
 * Exposes `screen_evm_address` for autonomous AI agents.
 */
import readline from "node:readline";
import { screenEvmAddress } from "./risk_engine.mjs";

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function writeResponse(id, result, error = null) {
  const msg = error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = req;
  try {
    if (method === "initialize") {
      return writeResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "aegisgate-mcp", version: "0.1.0" }
      });
    }
    if (method === "tools/list") {
      return writeResponse(id, {
        tools: [
          {
            name: "screen_evm_address",
            description: "Screen an EVM address for OFAC/mixer risk, contract bytecode, and EIP-1967 proxy status.",
            inputSchema: {
              type: "object",
              properties: {
                address: { type: "string", description: "0x-prefixed EVM address" },
                chain: { type: "string", enum: ["base", "ethereum", "arbitrum"], default: "base" }
              },
              required: ["address"]
            }
          }
        ]
      });
    }
    if (method === "tools/call" && params?.name === "screen_evm_address") {
      const report = await screenEvmAddress(params.arguments?.address, params.arguments?.chain || "base");
      return writeResponse(id, {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }]
      });
    }
    if (id !== undefined) {
      writeResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
    }
  } catch (err) {
    if (id !== undefined) {
      writeResponse(id, null, { code: -32000, message: err.message });
    }
  }
});

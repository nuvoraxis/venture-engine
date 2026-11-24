/**
 * AuditPulse Stdio MCP Server (JSON-RPC 2.0)
 * Exposes contract/pool invariant inspection, risk-diff webhook formatting,
 * and Base USDC x402 receipt verification for autonomous AI agents.
 */
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { inspectContractAndInvariants } from "./inspector.mjs";
import { diffInspectionSnapshots, formatWebhookPayload } from "./diff_alert.mjs";
import { createBoundedReplayStore, verifyBaseUsdcPayment } from "./x402.mjs";

const MCP_TOOLS = [
  {
    name: "inspect_contract_invariants",
    description:
      "Inspect a smart contract, ERC-20 token, or DEX/Vault pool for proxy/admin slots, bytecode opcodes, ERC-20 supply/decimals sanity, and reserve balance invariants.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "0x-prefixed EVM contract or pool address" },
        chain: { type: "string", enum: ["base", "ethereum", "arbitrum"], default: "base" },
        tokens: {
          type: "array",
          items: { type: "string" },
          description: "Optional extra ERC-20 token addresses to snapshot reserves for"
        }
      },
      required: ["address"]
    }
  },
  {
    name: "diff_contract_snapshots",
    description:
      "Compute a risk diff between two AuditPulse inspection snapshots and format a webhook alert payload (generic, slack, or discord).",
    inputSchema: {
      type: "object",
      properties: {
        previous: { type: "object", description: "Baseline AuditPulse inspection report" },
        current: {
          type: "object",
          description: "New AuditPulse inspection report (if omitted, fetches live state via JSON-RPC)"
        },
        format: { type: "string", enum: ["generic", "slack", "discord"], default: "generic" },
        reserveDropPctThreshold: { type: "number", default: 10 },
        supplyChangePctThreshold: { type: "number", default: 20 }
      },
      required: ["previous"]
    }
  },
  {
    name: "verify_x402_payment",
    description:
      "Verify a Base Mainnet USDC x402 payment transaction receipt against the receive-only treasury.",
    inputSchema: {
      type: "object",
      properties: {
        txHash: { type: "string", description: "0x-prefixed 64-hex Base transaction hash" },
        minAmountUsdcUnits: {
          type: "string",
          default: "20000",
          description: "Minimum USDC amount in 6-decimal base units (20000 = $0.02)"
        }
      },
      required: ["txHash"]
    }
  }
];

export async function handleMcpMessage(req, { fetchImpl = fetch, consumedTxHashes = createBoundedReplayStore() } = {}) {
  if (!req || typeof req !== "object") return null;
  const { id, method, params } = req;

  // Notifications without an id do not expect a JSON-RPC response
  if (id === undefined && typeof method === "string" && method.startsWith("notifications/")) {
    return null;
  }

  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "auditpulse-mcp", version: "0.1.0" }
        }
      };
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === "inspect_contract_invariants") {
        const report = await inspectContractAndInvariants(args.address, {
          chain: args.chain || "base",
          tokens: args.tokens || [],
          fetchImpl
        });
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] }
        };
      }

      if (toolName === "diff_contract_snapshots") {
        if (!args.previous) {
          throw new Error("Missing required argument: previous");
        }
        const current =
          args.current ||
          (await inspectContractAndInvariants(args.previous.address, {
            chain: args.previous.chain || "base",
            fetchImpl
          }));
        const diff = diffInspectionSnapshots(args.previous, current, {
          reserveDropPctThreshold: args.reserveDropPctThreshold ?? 10,
          supplyChangePctThreshold: args.supplyChangePctThreshold ?? 20
        });
        const webhook = formatWebhookPayload(diff, args.format || "generic");
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify({ diff, webhook }, null, 2) }] }
        };
      }

      if (toolName === "verify_x402_payment") {
        const minUnits = BigInt(args.minAmountUsdcUnits ?? "20000");
        const result = await verifyBaseUsdcPayment(args.txHash, minUnits, consumedTxHashes, fetchImpl);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` }
      };
    }

    if (id !== undefined) {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
    return null;
  } catch (err) {
    if (id === undefined) return null;
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err?.message || "Internal error" }
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const consumedTxHashes = createBoundedReplayStore();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    const response = await handleMcpMessage(req, { consumedTxHashes });
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  });
}

/**
 * GasPulse & Mempool Guard Stdio MCP Server (JSON-RPC 2.0, MCP 2024-11-05).
 * Exposes `estimate_gas`, `simulate_transaction`, and `check_rpc_health` for autonomous AI agents.
 */
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { SUPPORTED_CHAIN_NAMES } from "./chains.mjs";
import { RpcPool } from "./rpc_pool.mjs";
import { estimateGasMetrics, simulateTransaction } from "./gas_pulse.mjs";

export const MCP_TOOLS = Object.freeze([
  {
    name: "estimate_gas",
    description:
      "Estimate EIP-1559 gas fees (slow/standard/fast/urgent), base fee trend, and congestion across Base, Ethereum, and Arbitrum using latency-sorted failover RPCs.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: SUPPORTED_CHAIN_NAMES, default: "base" }
      }
    }
  },
  {
    name: "simulate_transaction",
    description:
      "Run pre-flight eth_call and eth_estimateGas simulation with Solidity revert decoding, OFAC/mixer pre-check, native balance sufficiency check, and mempool guard warnings.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: SUPPORTED_CHAIN_NAMES, default: "base" },
        from: { type: "string", description: "Optional 0x-prefixed sender address" },
        to: { type: "string", description: "Target contract or recipient 0x-prefixed address" },
        data: { type: "string", description: "0x-prefixed calldata bytes", default: "0x" },
        value: { type: "string", description: "Native wei amount in decimal or 0x hex", default: "0x0" },
        gas: { type: "string", description: "Optional gas limit in decimal or 0x hex" },
        maxFeePerGas: { type: "string", description: "Optional maxFeePerGas in wei" },
        maxPriorityFeePerGas: { type: "string", description: "Optional maxPriorityFeePerGas in wei" },
        blockTag: { type: "string", default: "latest" }
      }
    }
  },
  {
    name: "check_rpc_health",
    description:
      "Probe multi-chain RPC endpoint latency, block height lag, and circuit-breaker health status.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: SUPPORTED_CHAIN_NAMES, description: "Optional chain filter; omit to probe all chains" }
      }
    }
  }
]);

export function createMcpDispatcher({ rpcPool = null, fetchImpl = fetch } = {}) {
  const pool = rpcPool || new RpcPool({ fetchImpl });

  return async function dispatchMcpRequest(req) {
    if (!req || typeof req !== "object") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }

    const { id, method, params } = req;
    const isNotification = id === undefined || id === null;

    try {
      if (method === "notifications/initialized") {
        return null;
      }
      if (method === "ping") {
        return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
      }
      if (method === "initialize") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "gaspulse-mcp", version: "0.1.0" }
          }
        };
      }
      if (method === "tools/list") {
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: MCP_TOOLS }
        };
      }
      if (method === "tools/call") {
        const toolName = params?.name;
        const args = params?.arguments || {};

        if (toolName === "estimate_gas") {
          const report = await estimateGasMetrics(args.chain || "base", pool);
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] }
          };
        }

        if (toolName === "simulate_transaction") {
          const simulation = await simulateTransaction(args, pool);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: Boolean(simulation.blocked),
              content: [{ type: "text", text: JSON.stringify(simulation, null, 2) }]
            }
          };
        }

        if (toolName === "check_rpc_health") {
          const health = args.chain ? await pool.probeChain(args.chain) : await pool.probeAll();
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(health, null, 2) }] }
          };
        }

        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${toolName}` }
        };
      }

      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      };
    } catch (err) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: err?.message || "Internal error" }) }]
        }
      };
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dispatch = createMcpDispatcher();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"
      );
      return;
    }

    const response = await dispatch(req);
    if (response !== null) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  });
}

/**
 * Remote Streamable HTTP JSON-RPC 2.0 MCP Handler (`POST /mcp`)
 * Exposes all 7 Venture Engine tools across AegisGate, GasPulse, and AuditPulse.
 * Allows free `initialize` / `tools/list` / `ping`; enforces `X-Api-Key` or `X-Payment-Tx` on `tools/call`.
 */
import { CANONICAL_CHAINS, screenEvmAddress } from "../../products/aegisgate/src/risk_engine.mjs";
import { SUPPORTED_CHAIN_NAMES } from "../../products/gaspulse/src/chains.mjs";
import { RpcPool } from "../../products/gaspulse/src/rpc_pool.mjs";
import { estimateGasMetrics, simulateTransaction } from "../../products/gaspulse/src/gas_pulse.mjs";
import { inspectContractAndInvariants } from "../../products/auditpulse/src/inspector.mjs";
import { diffInspectionSnapshots, formatWebhookPayload } from "../../products/auditpulse/src/diff_alert.mjs";
import {
  build402Payload,
  createBoundedReplayStore,
  verifyBaseUsdcPayment
} from "../../products/auditpulse/src/x402.mjs";
import { authenticateApiKeyHeader, parseStaticKeySet } from "./auth_tokens.mjs";

export const MAX_MCP_BODY_BYTES = 512 * 1024;
const STANDARD_TOOL_PRICE_UNITS = 10000n; // $0.01 Base USDC
const INSPECT_TOOL_PRICE_UNITS = 20000n;  // $0.02 Base USDC
const BATCH_TOOL_PRICE_UNITS = 50000n;    // $0.05 Base USDC (up to 20 addresses)

export const ALL_MCP_TOOLS = Object.freeze([
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
  },
  {
    name: "estimate_gas",
    description:
      "Estimate EIP-1559 gas fees (slow/standard/fast/urgent), base fee trend, and congestion across Base, Ethereum, and Arbitrum.",
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
      "Run pre-flight eth_call and eth_estimateGas simulation with Solidity revert decoding, OFAC/mixer pre-check, and mempool guard warnings.",
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
    description: "Probe multi-chain RPC endpoint latency, block height lag, and circuit-breaker health status.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: SUPPORTED_CHAIN_NAMES, description: "Optional chain filter; omit to probe all chains" }
      }
    }
  },
  {
    name: "inspect_contract_invariants",
    description:
      "Inspect a smart contract, ERC-20 token, or DEX/Vault pool for proxy/admin slots, bytecode opcodes, ERC-20 sanity, and reserve invariants.",
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
    description: "Verify a Base Mainnet USDC x402 payment transaction receipt against the receive-only treasury.",
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
  },
  {
    name: "batch_screen_evm_addresses",
    description: "Screen up to 20 EVM addresses in parallel for OFAC/mixer risk, contract bytecode, and EIP-1967 proxy status ($0.05 Base USDC).",
    inputSchema: {
      type: "object",
      properties: {
        addresses: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
          description: "Array of 1 to 20 0x-prefixed EVM addresses"
        },
        chain: { type: "string", enum: ["base", "ethereum", "arbitrum"], default: "base" }
      },
      required: ["addresses"]
    }
  }
]);

const TOOL_PRICE_UNITS = new Map([
  ["screen_evm_address", STANDARD_TOOL_PRICE_UNITS],
  ["batch_screen_evm_addresses", BATCH_TOOL_PRICE_UNITS],
  ["estimate_gas", STANDARD_TOOL_PRICE_UNITS],
  ["simulate_transaction", STANDARD_TOOL_PRICE_UNITS],
  ["check_rpc_health", STANDARD_TOOL_PRICE_UNITS],
  ["inspect_contract_invariants", INSPECT_TOOL_PRICE_UNITS],
  ["diff_contract_snapshots", STANDARD_TOOL_PRICE_UNITS],
  ["verify_x402_payment", STANDARD_TOOL_PRICE_UNITS]
]);

function jsonRpcResponse(status, payload, corsHeaders) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders
    }
  });
}

export function firstRpcUrl(override) {
  if (Array.isArray(override)) {
    const candidate = override.find((u) => typeof u === "string" && u.trim());
    return candidate ? candidate.trim() : null;
  }
  if (typeof override === "string" && override.trim()) {
    return override.trim();
  }
  return null;
}

export function buildChainOverrideFetch(fetchImpl, rpcOverrides = {}) {
  const urlMap = new Map();
  for (const [chain, cfg] of Object.entries(CANONICAL_CHAINS)) {
    const targetUrl = firstRpcUrl(rpcOverrides[chain]);
    if (!targetUrl) continue;
    const candidates = Array.isArray(cfg.rpcs) && cfg.rpcs.length > 0 ? cfg.rpcs : [cfg.rpc];
    for (const candidate of candidates) {
      if (candidate) urlMap.set(candidate, targetUrl);
    }
  }
  return (url, init) => fetchImpl(urlMap.get(url) || url, init);
}

async function runTool(toolName, args, { fetchImpl, rpcPool, consumedTxHashes, rpcOverrides }) {
  if (toolName === "screen_evm_address") {
    const chain = args.chain || "base";
    const scopedFetch = buildChainOverrideFetch(fetchImpl, rpcOverrides);
    const report = await screenEvmAddress(args.address, chain, scopedFetch);
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  }

  if (toolName === "batch_screen_evm_addresses") {
    const addresses = Array.isArray(args.addresses) ? args.addresses : null;
    if (!addresses || addresses.length === 0 || addresses.length > 20) {
      throw new Error("addresses must be a non-empty array of 1 to 20 EVM addresses");
    }
    const chain = args.chain || "base";
    const scopedFetch = buildChainOverrideFetch(fetchImpl, rpcOverrides);
    const results = await Promise.all(
      addresses.map((addr) => screenEvmAddress(String(addr || ""), chain, scopedFetch))
    );
    const summary = {
      chain,
      total: results.length,
      blockedCount: results.filter((r) => r.verdict === "BLOCK").length,
      reviewCount: results.filter((r) => r.verdict === "REVIEW").length,
      allowCount: results.filter((r) => r.verdict === "ALLOW").length,
      results
    };
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }

  if (toolName === "estimate_gas") {
    const report = await estimateGasMetrics(args.chain || "base", rpcPool);
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  }

  if (toolName === "simulate_transaction") {
    const simulation = await simulateTransaction(args, rpcPool);
    return {
      isError: Boolean(simulation.blocked),
      content: [{ type: "text", text: JSON.stringify(simulation, null, 2) }]
    };
  }

  if (toolName === "check_rpc_health") {
    const health = args.chain ? await rpcPool.probeChain(args.chain) : await rpcPool.probeAll();
    return { content: [{ type: "text", text: JSON.stringify(health, null, 2) }] };
  }

  if (toolName === "inspect_contract_invariants") {
    const report = await inspectContractAndInvariants(args.address, {
      chain: args.chain || "base",
      tokens: args.tokens || [],
      fetchImpl,
      rpcOverrides
    });
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  }

  if (toolName === "diff_contract_snapshots") {
    if (!args.previous) {
      throw new Error("Missing required argument: previous");
    }
    const current =
      args.current ||
      (await inspectContractAndInvariants(args.previous.address, {
        chain: args.previous.chain || "base",
        fetchImpl,
        rpcOverrides
      }));
    const diff = diffInspectionSnapshots(args.previous, current, {
      reserveDropPctThreshold: args.reserveDropPctThreshold ?? 10,
      supplyChangePctThreshold: args.supplyChangePctThreshold ?? 20
    });
    const webhook = formatWebhookPayload(diff, args.format || "generic");
    return { content: [{ type: "text", text: JSON.stringify({ diff, webhook }, null, 2) }] };
  }

  if (toolName === "verify_x402_payment") {
    const rawUnits = args.minAmountUsdcUnits ?? "20000";
    if (!/^\d+$/.test(String(rawUnits))) {
      throw new Error("minAmountUsdcUnits must be a non-negative integer string");
    }
    const result = await verifyBaseUsdcPayment(
      args.txHash,
      BigInt(String(rawUnits)),
      consumedTxHashes,
      fetchImpl,
      rpcOverrides
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  return null;
}

/**
 * Creates a Streamable HTTP JSON-RPC 2.0 MCP request handler (`POST /mcp`).
 */
export function createMcpHttpHandler({
  fetchImpl = fetch,
  rpcPool = null,
  rpcOverrides = {},
  consumedTxHashes = createBoundedReplayStore(10000),
  tokenSecret = "",
  staticKeys = new Set(),
  corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, X-Payment-Tx"
  }
} = {}) {
  const pool = rpcPool || new RpcPool({ rpcOverrides, fetchImpl });
  const baseStaticKeys = parseStaticKeySet(staticKeys);

  return async function handleMcpHttpRequest(request, context = {}) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return jsonRpcResponse(
        405,
        { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method Not Allowed: use POST /mcp" } },
        { ...corsHeaders, Allow: "POST, OPTIONS" }
      );
    }

    const rawText = await request.text();
    if (new TextEncoder().encode(rawText).byteLength > MAX_MCP_BODY_BYTES) {
      return jsonRpcResponse(
        413,
        { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Request body exceeds byte limit" } },
        corsHeaders
      );
    }

    let req;
    try {
      req = JSON.parse(rawText);
    } catch {
      return jsonRpcResponse(
        400,
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        corsHeaders
      );
    }

    if (!req || typeof req !== "object" || Array.isArray(req)) {
      return jsonRpcResponse(
        400,
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
        corsHeaders
      );
    }

    const { id, method, params } = req;
    const isNotification = id === undefined || id === null;

    if (method === "notifications/initialized") {
      return new Response(null, { status: 202, headers: corsHeaders });
    }
    if (method === "ping") {
      return isNotification
        ? new Response(null, { status: 202, headers: corsHeaders })
        : jsonRpcResponse(200, { jsonrpc: "2.0", id, result: {} }, corsHeaders);
    }
    if (method === "initialize") {
      return jsonRpcResponse(
        200,
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "venture-engine-gateway-mcp", version: "0.1.0" }
          }
        },
        corsHeaders
      );
    }
    if (method === "tools/list") {
      return jsonRpcResponse(200, { jsonrpc: "2.0", id, result: { tools: ALL_MCP_TOOLS } }, corsHeaders);
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const priceUnits = TOOL_PRICE_UNITS.get(toolName) ?? STANDARD_TOOL_PRICE_UNITS;

      const activeSecret = context.tokenSecret || context.env?.VE_TOKEN_SECRET || tokenSecret;
      const activeStaticKeys = parseStaticKeySet(
        baseStaticKeys,
        context.staticKeys,
        context.env?.VE_STATIC_API_KEYS,
        context.env?.MCP_API_KEYS
      );
      const activeFetch = context.fetchImpl || fetchImpl;
      const activeConsumedTx = context.consumedTxHashes || consumedTxHashes;
      const activeRpcOverrides = context.rpcOverrides || rpcOverrides;

      const apiKeyHeader = request.headers.get("x-api-key");
      const paymentTxHeader = request.headers.get("x-payment-tx");

      let authorized = false;

      if (apiKeyHeader && apiKeyHeader.trim()) {
        const authRes = await authenticateApiKeyHeader(apiKeyHeader, {
          tokenSecret: activeSecret,
          staticKeys: activeStaticKeys,
          nowMs: context.nowMs
        });
        if (!authRes.ok) {
          return jsonRpcResponse(
            401,
            {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32001,
                message: "Unauthorized: invalid or expired X-Api-Key",
                data: { reason: authRes.reason }
              }
            },
            corsHeaders
          );
        }
        authorized = true;
      } else if (paymentTxHeader && paymentTxHeader.trim()) {
        const verification = await verifyBaseUsdcPayment(
          paymentTxHeader.trim(),
          priceUnits,
          activeConsumedTx,
          activeFetch,
          activeRpcOverrides
        );
        if (!verification.ok) {
          const isAmlBlock = verification.reason === "PAYER_BLOCKED_BY_AML";
          const x402Payload = build402Payload(priceUnits, "/mcp", `MCP tool ${toolName || "call"}`);
          return jsonRpcResponse(
            isAmlBlock ? 403 : 402,
            {
              jsonrpc: "2.0",
              id,
              error: {
                code: isAmlBlock ? -32003 : -32002,
                message: isAmlBlock ? "Payer address blocked by AML screening" : "Payment verification failed",
                data: { ...x402Payload, paymentError: verification.reason }
              },
              ...x402Payload,
              paymentError: verification.reason
            },
            corsHeaders
          );
        }
        authorized = true;
      }

      if (!authorized) {
        const x402Payload = build402Payload(priceUnits, "/mcp", `MCP tool ${toolName || "call"}`);
        return jsonRpcResponse(
          402,
          {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32002,
              message: "Payment Required: provide X-Api-Key or X-Payment-Tx",
              data: x402Payload
            },
            ...x402Payload
          },
          corsHeaders
        );
      }

      try {
        const result = await runTool(toolName, args, {
          fetchImpl: activeFetch,
          rpcPool: pool,
          consumedTxHashes: activeConsumedTx,
          rpcOverrides: activeRpcOverrides
        });
        if (!result) {
          return jsonRpcResponse(
            200,
            { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${toolName}` } },
            corsHeaders
          );
        }
        return jsonRpcResponse(200, { jsonrpc: "2.0", id, result }, corsHeaders);
      } catch (err) {
        return jsonRpcResponse(
          200,
          {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: JSON.stringify({ error: err?.message || "Tool execution failed" }) }]
            }
          },
          corsHeaders
        );
      }
    }

    if (isNotification) {
      return new Response(null, { status: 202, headers: corsHeaders });
    }
    return jsonRpcResponse(
      200,
      { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } },
      corsHeaders
    );
  };
}

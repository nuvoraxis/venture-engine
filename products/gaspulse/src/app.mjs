/**
 * Unified Web-Standard HTTP Handler for GasPulse & Mempool Guard.
 * Shared across both Node.js (server.mjs) and Cloudflare Workers (worker.mjs) with zero duplicated logic.
 */
import { SUPPORTED_CHAIN_NAMES, TREASURY_ADDRESS } from "./chains.mjs";
import { RpcPool, RpcPoolError } from "./rpc_pool.mjs";
import { estimateGasMetrics, simulateTransaction } from "./gas_pulse.mjs";
import {
  BASE_USDC_ADDRESS,
  DEFAULT_PRICE_USDC_UNITS,
  authorizeRequest,
  createReplayStore,
  parseApiKeyStore
} from "./x402.mjs";

const MAX_BODY_BYTES = 65536;
const SERVICE_VERSION = "0.1.0";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, X-Payment-Tx",
  "X-Content-Type-Options": "nosniff"
};

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

async function readJsonBodyBounded(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    const err = new Error(`Request body exceeds ${MAX_BODY_BYTES} byte limit`);
    err.statusCode = 413;
    throw err;
  }

  const rawText = await request.text();
  const byteLength = new TextEncoder().encode(rawText).byteLength;
  if (byteLength > MAX_BODY_BYTES) {
    const err = new Error(`Request body exceeds ${MAX_BODY_BYTES} byte limit`);
    err.statusCode = 413;
    throw err;
  }
  if (!rawText.trim()) {
    throw new Error("Empty JSON request body");
  }
  try {
    return JSON.parse(rawText);
  } catch {
    throw new Error("Malformed JSON request body");
  }
}

function simulationPayloadFromSearchParams(searchParams) {
  const payload = {};
  for (const key of ["chain", "blockTag", "from", "to", "data", "value", "gas", "maxFeePerGas", "maxPriorityFeePerGas"]) {
    const val = searchParams.get(key);
    if (val !== null && val !== "") {
      payload[key] = val;
    }
  }
  return payload;
}

export function createGasPulseHandler({
  fetchImpl = fetch,
  rpcOverrides = {},
  rpcPool = null,
  apiKeys = new Set(),
  consumedTxHashes = null,
  inFlightTxHashes = null,
  timeoutMs = 4000,
  priceUsdcUnits = DEFAULT_PRICE_USDC_UNITS
} = {}) {
  const pool =
    rpcPool ||
    new RpcPool({
      rpcOverrides,
      fetchImpl,
      timeoutMs
    });
  const keyStore = parseApiKeyStore(apiKeys);
  const replayStore = consumedTxHashes || createReplayStore(10000);
  const inFlight = inFlightTxHashes || new Set();

  return async function handleRequest(request) {
    try {
      const method = (request.method || "GET").toUpperCase();
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url, "https://gaspulse.local");
      const pathname = url.pathname;

      if (method === "GET" && pathname === "/") {
        return jsonResponse(200, {
          service: "gaspulse",
          name: "GasPulse & Mempool Guard",
          version: SERVICE_VERSION,
          chains: SUPPORTED_CHAIN_NAMES,
          treasury: TREASURY_ADDRESS,
          endpoints: {
            health: "GET /health",
            pricing: "GET /v1/pricing",
            rpcHealth: "GET /v1/rpc-health?probe=true&chain=base",
            gas: "GET /v1/gas?chain=base",
            simulate: "POST /v1/simulate"
          }
        });
      }

      if (method === "GET" && pathname === "/health") {
        return jsonResponse(200, {
          status: "ok",
          service: "gaspulse",
          version: SERVICE_VERSION,
          chains: SUPPORTED_CHAIN_NAMES,
          treasury: TREASURY_ADDRESS
        });
      }

      if (method === "GET" && pathname === "/v1/pricing") {
        return jsonResponse(200, {
          service: "gaspulse",
          x402_per_call_usdc: "0.01",
          x402_per_call_units: String(priceUsdcUnits),
          b2b_plans_usdc_monthly: {
            starter: 79,
            growth: 149,
            enterprise: 299
          },
          kyc_required_for_b2b: true,
          treasury: TREASURY_ADDRESS,
          network: "base-mainnet",
          asset: BASE_USDC_ADDRESS
        });
      }

      if (method === "GET" && pathname === "/v1/rpc-health") {
        const chainParam = url.searchParams.get("chain");
        const shouldProbe = url.searchParams.get("probe") === "true" || url.searchParams.get("probe") === "1";
        const health = shouldProbe
          ? chainParam
            ? await pool.probeChain(chainParam)
            : await pool.probeAll()
          : pool.getHealthSnapshot(chainParam || null);

        return jsonResponse(200, {
          service: "gaspulse",
          probed: shouldProbe,
          health
        });
      }

      if (method === "GET" && pathname === "/v1/gas") {
        const auth = await authorizeRequest({
          headers: request.headers,
          resourcePath: pathname,
          priceUsdcUnits,
          apiKeys: keyStore,
          consumedTxHashes: replayStore,
          inFlightTxHashes: inFlight,
          fetchImpl,
          rpcPool: pool
        });
        if (!auth.ok) {
          return jsonResponse(auth.status, auth.body);
        }

        const chain = url.searchParams.get("chain") || "base";
        const gas = await estimateGasMetrics(chain, pool);
        return jsonResponse(200, {
          gas,
          auth: { method: auth.authMethod, tier: auth.tier || null },
          paymentReceipt: auth.paymentReceipt
        });
      }

      if ((method === "POST" || method === "GET") && pathname === "/v1/simulate") {
        const auth = await authorizeRequest({
          headers: request.headers,
          resourcePath: pathname,
          priceUsdcUnits,
          apiKeys: keyStore,
          consumedTxHashes: replayStore,
          inFlightTxHashes: inFlight,
          fetchImpl,
          rpcPool: pool
        });
        if (!auth.ok) {
          return jsonResponse(auth.status, auth.body);
        }

        const payload =
          method === "POST"
            ? await readJsonBodyBounded(request)
            : simulationPayloadFromSearchParams(url.searchParams);

        const simulation = await simulateTransaction(payload, pool);
        const status = simulation.blocked ? 403 : 200;
        return jsonResponse(status, {
          simulation,
          auth: { method: auth.authMethod, tier: auth.tier || null },
          paymentReceipt: auth.paymentReceipt
        });
      }

      return jsonResponse(404, { error: "Not Found" });
    } catch (err) {
      if (err instanceof RpcPoolError) {
        return jsonResponse(502, {
          error: err.message,
          code: "UPSTREAM_RPC_UNAVAILABLE",
          attempts: err.attempts
        });
      }
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 400;
      return jsonResponse(status, { error: err?.message || "Bad Request" });
    }
  };
}

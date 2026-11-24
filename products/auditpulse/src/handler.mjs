/**
 * Runtime-agnostic Web Fetch Request/Response handler for AuditPulse.
 * Shared identically by the Node.js HTTP server (src/server.mjs) and Cloudflare Worker (src/worker.mjs).
 */
import { CANONICAL_CHAINS, RpcUpstreamError } from "./chains.mjs";
import { inspectContractAndInvariants } from "./inspector.mjs";
import { diffInspectionSnapshots, formatWebhookPayload } from "./diff_alert.mjs";
import {
  TREASURY_ADDRESS,
  build402Payload,
  createBoundedReplayStore,
  verifyBaseUsdcPayment
} from "./x402.mjs";

export const SERVICE_VERSION = "0.1.0";
export const PRICE_INSPECT_USDC_UNITS = 20000n; // $0.02 USDC
export const PRICE_DIFF_USDC_UNITS = 10000n; // $0.01 USDC
export const MAX_JSON_BODY_BYTES = 512 * 1024; // 512 KB cap for <40 MB RAM safety

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, X-Payment-Tx"
};

export function parseApiKeySet(rawKeys) {
  if (rawKeys instanceof Set) return rawKeys;
  if (Array.isArray(rawKeys)) {
    return new Set(rawKeys.map((k) => String(k).trim()).filter(Boolean));
  }
  if (typeof rawKeys === "string") {
    return new Set(
      rawKeys
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
    );
  }
  return new Set();
}

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

async function readJsonBody(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_JSON_BODY_BYTES) {
    const err = new Error(`Request body exceeds ${MAX_JSON_BODY_BYTES} byte limit`);
    err.statusCode = 413;
    throw err;
  }

  const rawText = await request.text();
  if (new TextEncoder().encode(rawText).byteLength > MAX_JSON_BODY_BYTES) {
    const err = new Error(`Request body exceeds ${MAX_JSON_BODY_BYTES} byte limit`);
    err.statusCode = 413;
    throw err;
  }

  if (!rawText.trim()) return {};
  try {
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON body must be an object");
    }
    return parsed;
  } catch (err) {
    const bad = new Error(`Invalid JSON body: ${err.message}`);
    bad.statusCode = 400;
    throw bad;
  }
}

async function authorizeCall(request, priceUnits, resourcePath, { apiKeys, consumedTxHashes, fetchImpl, rpcOverrides }) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey && apiKeys.has(apiKey.trim())) {
    return { authorized: true, paymentReceipt: null };
  }

  const paymentTx = request.headers.get("x-payment-tx");
  if (paymentTx) {
    const verification = await verifyBaseUsdcPayment(
      paymentTx.trim(),
      priceUnits,
      consumedTxHashes,
      fetchImpl,
      rpcOverrides
    );
    if (!verification.ok) {
      return {
        authorized: false,
        response: jsonResponse(402, {
          ...build402Payload(priceUnits, resourcePath),
          paymentError: verification.reason
        })
      };
    }
    return { authorized: true, paymentReceipt: verification };
  }

  return {
    authorized: false,
    response: jsonResponse(402, build402Payload(priceUnits, resourcePath))
  };
}

/**
 * Creates a Web Standard `(request) => Promise<Response>` handler for AuditPulse.
 */
export function createAuditPulseHandler({
  fetchImpl = fetch,
  apiKeys = new Set(),
  consumedTxHashes = createBoundedReplayStore(),
  rpcOverrides = {}
} = {}) {
  const keySet = parseApiKeySet(apiKeys);

  return async function handleRequest(request) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);
      const { pathname, searchParams } = url;

      if (request.method === "GET" && pathname === "/") {
        return jsonResponse(200, {
          service: "auditpulse",
          version: SERVICE_VERSION,
          description: "Continuous Smart-Contract & Pool Invariant Risk Monitor",
          chains: Object.keys(CANONICAL_CHAINS),
          endpoints: {
            health: "GET /health",
            pricing: "GET /v1/pricing",
            inspect: "GET|POST /v1/inspect?address=0x...&chain=base",
            diff: "POST /v1/diff"
          },
          treasury: TREASURY_ADDRESS
        });
      }

      if (request.method === "GET" && pathname === "/health") {
        return jsonResponse(200, {
          status: "ok",
          service: "auditpulse",
          version: SERVICE_VERSION,
          chains: Object.keys(CANONICAL_CHAINS),
          treasury: TREASURY_ADDRESS
        });
      }

      if (request.method === "GET" && pathname === "/v1/pricing") {
        return jsonResponse(200, {
          x402_per_call_usdc: {
            inspect: "0.02",
            diff: "0.01"
          },
          b2b_plans_usdc_monthly: {
            starter: 149,
            growth: 299,
            enterprise: 499
          },
          treasury: TREASURY_ADDRESS,
          network: "base-mainnet"
        });
      }

      if (pathname === "/v1/inspect") {
        if (request.method !== "GET" && request.method !== "POST") {
          return jsonResponse(405, { error: "Method Not Allowed" });
        }

        const auth = await authorizeCall(request, PRICE_INSPECT_USDC_UNITS, pathname, {
          apiKeys: keySet,
          consumedTxHashes,
          fetchImpl,
          rpcOverrides
        });
        if (!auth.authorized) return auth.response;

        let address = searchParams.get("address") || "";
        let chain = searchParams.get("chain") || "base";
        let tokens = searchParams.get("tokens") || "";

        if (request.method === "POST") {
          const body = await readJsonBody(request);
          if (body.address !== undefined) address = String(body.address);
          if (body.chain !== undefined) chain = String(body.chain);
          if (body.tokens !== undefined) tokens = body.tokens;
        }

        const report = await inspectContractAndInvariants(address, {
          chain,
          tokens,
          fetchImpl,
          rpcOverrides
        });
        return jsonResponse(200, { report, paymentReceipt: auth.paymentReceipt });
      }

      if (pathname === "/v1/diff") {
        if (request.method !== "POST") {
          return jsonResponse(405, { error: "Method Not Allowed" });
        }

        const auth = await authorizeCall(request, PRICE_DIFF_USDC_UNITS, pathname, {
          apiKeys: keySet,
          consumedTxHashes,
          fetchImpl,
          rpcOverrides
        });
        if (!auth.authorized) return auth.response;

        const body = await readJsonBody(request);
        if (!body.previous) {
          return jsonResponse(400, { error: "Request body requires `previous` snapshot object" });
        }

        const format = body.format || "generic";
        let currentSnapshot = body.current;
        let fetchedLive = false;

        if (!currentSnapshot) {
          const targetAddress = body.address || body.previous.address;
          const targetChain = body.chain || body.previous.chain || "base";
          currentSnapshot = await inspectContractAndInvariants(targetAddress, {
            chain: targetChain,
            tokens: body.tokens || [],
            fetchImpl,
            rpcOverrides
          });
          fetchedLive = true;
        }

        if (body.options !== undefined && (!body.options || typeof body.options !== "object" || Array.isArray(body.options))) {
          return jsonResponse(400, { error: "Request body `options` must be an object" });
        }

        const diff = diffInspectionSnapshots(body.previous, currentSnapshot, body.options || {});
        const webhook = formatWebhookPayload(diff, format);

        return jsonResponse(200, {
          diff,
          webhook,
          ...(fetchedLive ? { current: currentSnapshot } : {}),
          paymentReceipt: auth.paymentReceipt
        });
      }

      return jsonResponse(404, { error: "Not Found" });
    } catch (err) {
      if (err instanceof RpcUpstreamError) {
        return jsonResponse(502, { error: err.message });
      }
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 400;
      return jsonResponse(status, { error: err?.message || "Bad Request" });
    }
  };
}

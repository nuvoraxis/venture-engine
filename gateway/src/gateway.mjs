/**
 * Venture Engine Unified Single-URL Edge Gateway
 * Pure Web Standard Fetch API (zero node:* imports); mounts:
 *   - Portal (/, /health, /v1/plans, /v1/kyb-checkout, /v1/verify-invoice, /.well-known/x402.json, /llms.txt, /openapi.json)
 *   - /aegis/* -> AegisGate (prefix stripped)
 *   - /gaspulse/* -> GasPulse (prefix stripped)
 *   - /auditpulse/* -> AuditPulse (prefix stripped)
 *   - POST /mcp -> Streamable HTTP JSON-RPC 2.0 MCP server (all 7 tools)
 */
import { createPortalHandler } from "../../portal/src/app.mjs";
import { createBoundedInvoiceStore, createBoundedReplayStore } from "../../portal/src/kyb_gate.mjs";
import { createAegisHandler } from "../../products/aegisgate/src/app.mjs";
import { createGasPulseHandler } from "../../products/gaspulse/src/app.mjs";
import { RpcPool } from "../../products/gaspulse/src/rpc_pool.mjs";
import { createAuditPulseHandler } from "../../products/auditpulse/src/handler.mjs";
import { authenticateApiKeyHeader, issueApiToken, parseStaticKeySet } from "./auth_tokens.mjs";
import { buildChainOverrideFetch, createMcpHttpHandler, firstRpcUrl } from "./mcp_http.mjs";

const MAX_FORWARD_BODY_BYTES = 512 * 1024;

export const GATEWAY_CORS_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, X-Payment-Tx"
});

function generateInternalBridgeKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "ve_bridge_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function buildRpcOverrides(baseOverrides = {}, env = {}) {
  const merged = { ...baseOverrides };
  if (env?.BASE_RPC_URL) merged.base = env.BASE_RPC_URL;
  if (env?.ETH_RPC_URL) merged.ethereum = env.ETH_RPC_URL;
  if (env?.ARB_RPC_URL) merged.arbitrum = env.ARB_RPC_URL;
  return merged;
}

function jsonError(status, code, error) {
  return new Response(JSON.stringify({ ok: false, code, error }, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...GATEWAY_CORS_HEADERS
    }
  });
}

async function cloneRequestWithPrefixStrip(request, prefix, { injectApiKey = null, stripApiKey = false } = {}) {
  const url = new URL(request.url);
  const stripped = url.pathname.slice(prefix.length) || "/";
  url.pathname = stripped.startsWith("/") ? stripped : `/${stripped}`;

  const headers = new Headers(request.headers);
  if (injectApiKey) {
    headers.set("X-Api-Key", injectApiKey);
  } else if (stripApiKey) {
    headers.delete("x-api-key");
  }

  const method = (request.method || "GET").toUpperCase();
  const init = { method, headers };

  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const bodyBuf = await request.arrayBuffer();
    if (bodyBuf.byteLength > MAX_FORWARD_BODY_BYTES) {
      const err = new Error(`Request body exceeds ${MAX_FORWARD_BODY_BYTES} byte limit`);
      err.statusCode = 413;
      throw err;
    }
    init.body = bodyBuf;
  }

  return new Request(url.toString(), init);
}

function matchMountPrefix(pathname) {
  for (const prefix of ["/aegis", "/gaspulse", "/auditpulse"]) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return prefix;
    }
  }
  return null;
}

function buildDownstreamBundle({
  fetchImpl,
  consumedTxHashes,
  issuedInvoices,
  landingHtml,
  llmsTxt,
  rpcOverrides,
  bridgeKey,
  tokenSecret,
  staticKeys
}) {
  const rpcPool = new RpcPool({ rpcOverrides, fetchImpl });
  const baseRpcUrl = firstRpcUrl(rpcOverrides.base);

  const portalHandler = createPortalHandler({
    fetchImpl,
    consumedTxHashes,
    issuedInvoices,
    landingHtml,
    llmsTxt,
    ...(baseRpcUrl ? { rpcUrl: baseRpcUrl } : {})
  });

  const aegisFetch = buildChainOverrideFetch(fetchImpl, rpcOverrides);

  const aegisHandler = createAegisHandler({
    fetchImpl: aegisFetch,
    apiKeys: new Set([bridgeKey]),
    consumedTxHashes
  });

  const gasPulseHandler = createGasPulseHandler({
    fetchImpl,
    rpcOverrides,
    rpcPool,
    apiKeys: new Map([[bridgeKey, { kycStatus: "VERIFIED", tier: "b2b" }]]),
    consumedTxHashes
  });

  const auditPulseHandler = createAuditPulseHandler({
    fetchImpl,
    apiKeys: new Set([bridgeKey]),
    consumedTxHashes,
    rpcOverrides
  });

  const mcpHandler = createMcpHttpHandler({
    fetchImpl,
    rpcPool,
    rpcOverrides,
    consumedTxHashes,
    tokenSecret,
    staticKeys,
    corsHeaders: GATEWAY_CORS_HEADERS
  });

  return { portalHandler, aegisHandler, aegisFetch, gasPulseHandler, auditPulseHandler, mcpHandler };
}

async function maybeAttachIssuedApiKey(portalResponse, tokenSecret, nowMs) {
  if (!tokenSecret || typeof tokenSecret !== "string" || !tokenSecret.trim()) {
    return portalResponse;
  }
  if (portalResponse.status !== 200) {
    return portalResponse;
  }

  let body;
  try {
    body = await portalResponse.clone().json();
  } catch {
    return portalResponse;
  }

  if (
    !body ||
    body.ok !== true ||
    body.status !== "PAID_AND_VERIFIED" ||
    body.kybStatus !== "VERIFIED" ||
    body.paymentStatus !== "CONFIRMED" ||
    !body.invoice?.plan ||
    !body.invoice?.invoiceId ||
    !body.invoice?.payerAddress
  ) {
    return portalResponse;
  }

  const issued = await issueApiToken(
    {
      plan: body.invoice.plan,
      invoiceId: body.invoice.invoiceId,
      payerAddress: body.invoice.payerAddress,
      kybStatus: "VERIFIED",
      nowMs
    },
    tokenSecret
  );
  if (!issued) {
    return portalResponse;
  }

  const enriched = {
    ...body,
    apiKey: issued.token,
    tokenExpiresAt: new Date(issued.claims.exp * 1000).toISOString()
  };

  const headers = new Headers(portalResponse.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(enriched, null, 2), {
    status: portalResponse.status,
    headers
  });
}

/**
 * Creates the unified Web-Standard Fetch router for the entire Venture Engine suite.
 */
export function createGatewayHandler({
  fetchImpl = fetch,
  consumedTxHashes = createBoundedReplayStore(10000),
  issuedInvoices = createBoundedInvoiceStore(10000),
  rpcOverrides = {},
  tokenSecret = "",
  apiKeys = new Set(),
  landingHtml = null,
  llmsTxt = null
} = {}) {
  const bridgeKey = generateInternalBridgeKey();
  const baseStaticKeys = parseStaticKeySet(apiKeys);
  const bundlesByRpcKey = new Map();

  function getBundle(activeFetch, activeRpcOverrides) {
    const useDefault = activeFetch === fetchImpl;
    const key = useDefault ? JSON.stringify(activeRpcOverrides) : null;
    if (key !== null && bundlesByRpcKey.has(key)) {
      return bundlesByRpcKey.get(key);
    }
    const bundle = buildDownstreamBundle({
      fetchImpl: activeFetch,
      consumedTxHashes,
      issuedInvoices,
      landingHtml,
      llmsTxt,
      rpcOverrides: activeRpcOverrides,
      bridgeKey,
      tokenSecret,
      staticKeys: baseStaticKeys
    });
    if (key !== null) {
      if (bundlesByRpcKey.size >= 4) {
        const oldest = bundlesByRpcKey.keys().next().value;
        bundlesByRpcKey.delete(oldest);
      }
      bundlesByRpcKey.set(key, bundle);
    }
    return bundle;
  }

  return async function handleGatewayRequest(request, context = {}) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: GATEWAY_CORS_HEADERS });
      }

      const url = new URL(request.url);
      const activeFetch = context.fetchImpl || fetchImpl;
      const activeTokenSecret = context.tokenSecret || context.env?.VE_TOKEN_SECRET || tokenSecret;
      const activeRpcOverrides = buildRpcOverrides(rpcOverrides, context.env);
      const bundle = getBundle(activeFetch, activeRpcOverrides);

      if (url.pathname === "/mcp") {
        const mcpStaticKeys = parseStaticKeySet(
          baseStaticKeys,
          context.apiKeys,
          context.env?.VE_STATIC_API_KEYS,
          context.env?.MCP_API_KEYS
        );
        return bundle.mcpHandler(request, {
          ...context,
          fetchImpl: activeFetch,
          consumedTxHashes,
          tokenSecret: activeTokenSecret,
          staticKeys: mcpStaticKeys,
          rpcOverrides: activeRpcOverrides
        });
      }

      const mountPrefix = matchMountPrefix(url.pathname);
      if (mountPrefix) {
        const serviceStaticKeys =
          mountPrefix === "/aegis"
            ? parseStaticKeySet(baseStaticKeys, context.apiKeys, context.env?.VE_STATIC_API_KEYS, context.env?.AEGISGATE_API_KEYS)
            : mountPrefix === "/gaspulse"
              ? parseStaticKeySet(baseStaticKeys, context.apiKeys, context.env?.VE_STATIC_API_KEYS, context.env?.GASPULSE_API_KEYS)
              : parseStaticKeySet(baseStaticKeys, context.apiKeys, context.env?.VE_STATIC_API_KEYS, context.env?.AUDITPULSE_API_KEYS);

        const authCheck = await authenticateApiKeyHeader(request.headers.get("x-api-key"), {
          tokenSecret: activeTokenSecret,
          staticKeys: serviceStaticKeys,
          forbiddenKey: bridgeKey,
          nowMs: context.nowMs
        });
        if (authCheck.provided && !authCheck.ok) {
          return jsonError(authCheck.status, authCheck.reason, "Unauthorized: invalid or expired X-Api-Key");
        }

        const downstreamReq = await cloneRequestWithPrefixStrip(request, mountPrefix, {
          injectApiKey: authCheck.ok ? bridgeKey : null,
          stripApiKey: !authCheck.ok
        });

        if (mountPrefix === "/aegis") {
          const sanitizedEnv = context.env
            ? { ...context.env, AEGISGATE_API_KEYS: "", ASSETS: undefined }
            : undefined;
          return bundle.aegisHandler(downstreamReq, {
            env: sanitizedEnv,
            ctx: context.ctx,
            fetchImpl: bundle.aegisFetch,
            consumedTxHashes
          });
        }
        if (mountPrefix === "/gaspulse") {
          return bundle.gasPulseHandler(downstreamReq);
        }
        return bundle.auditPulseHandler(downstreamReq);
      }

      const baseRpcUrl = firstRpcUrl(activeRpcOverrides.base);
      const portalRes = await bundle.portalHandler(request, {
        ...context,
        fetchImpl: activeFetch,
        consumedTxHashes,
        issuedInvoices,
        ...(baseRpcUrl ? { rpcUrl: baseRpcUrl } : {})
      });

      if (
        request.method === "POST" &&
        (url.pathname === "/v1/kyb-checkout" || url.pathname === "/v1/verify-invoice")
      ) {
        return maybeAttachIssuedApiKey(portalRes, activeTokenSecret, context.nowMs);
      }

      return portalRes;
    } catch (err) {
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 400;
      return jsonError(status, status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST", err?.message || "Bad Request");
    }
  };
}

/**
 * AegisGate Shared Edge & Node HTTP Request Handler
 * Pure Web Standard Fetch API (zero node:* imports); shared across Cloudflare Workers,
 * Vercel Edge Functions, and the Node.js HTTP server.
 */
import { screenEvmAddress, CANONICAL_CHAINS } from "./risk_engine.mjs";
import { build402Payload, verifyBaseUsdcPayment, TREASURY_ADDRESS } from "./x402.mjs";
import openapiSpec from "../public/openapi.json" with { type: "json" };

export const PRICE_PER_SCREEN_USDC_UNITS = 10000n; // $0.01 USDC (6 decimals)
export const PRICE_PER_BATCH_USDC_UNITS = 50000n; // $0.05 USDC (up to 20 addresses)
export const MAX_BATCH_ADDRESSES = 20;

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, X-Payment-Tx"
};

const FALLBACK_LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AegisGate — EVM AML, Sanctions &amp; Contract Risk API</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0b1120; color: #e2e8f0; margin: 0; padding: 2rem; line-height: 1.5; }
    main { max-width: 720px; margin: 0 auto; }
    code, a { color: #38bdf8; }
    ul { padding-left: 1.25rem; }
  </style>
</head>
<body>
  <main>
    <h1>AegisGate API</h1>
    <p>Real-time EVM wallet AML, OFAC/mixer sanctions screening, and EIP-1967 proxy inspection across Base, Ethereum, and Arbitrum.</p>
    <ul>
      <li><a href="/health">/health</a> — Service &amp; treasury status</li>
      <li><a href="/v1/pricing">/v1/pricing</a> — x402 Base USDC ($0.01/call) &amp; B2B plans</li>
      <li><a href="/openapi.json">/openapi.json</a> — OpenAPI 3.1.0 specification</li>
      <li><code>GET /v1/screen?address=0x...&amp;chain=base</code> — Risk screening endpoint</li>
    </ul>
    <p>Receive-only Base/EVM USDC treasury: <code>${TREASURY_ADDRESS}</code></p>
  </main>
</body>
</html>`;

export function parseApiKeys(input) {
  if (!input) return new Set();
  if (input instanceof Set) {
    return new Set([...input].map((k) => String(k).trim()).filter(Boolean));
  }
  if (Array.isArray(input)) {
    return new Set(input.map((k) => String(k).trim()).filter(Boolean));
  }
  if (typeof input === "string") {
    return new Set(
      input
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
    );
  }
  return new Set();
}

export function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

function resolveAllowedApiKeys(baseKeys, context) {
  const merged = new Set(baseKeys);
  for (const key of parseApiKeys(context.apiKeys)) merged.add(key);
  for (const key of parseApiKeys(context.env?.AEGISGATE_API_KEYS)) merged.add(key);
  return merged;
}

async function tryServeStaticAsset(request, context) {
  const assets = context.env?.ASSETS;
  if (!assets || typeof assets.fetch !== "function") return null;
  const assetRes = await assets.fetch(request);
  if (!assetRes || assetRes.status === 404) return null;
  return assetRes;
}

/**
 * Creates a Web-standard Request -> Response handler shared by Node, Cloudflare Workers, and Edge runtimes.
 */
export function createAegisHandler({
  fetchImpl = fetch,
  apiKeys = new Set(),
  consumedTxHashes = new Set(),
  landingHtml = null
} = {}) {
  const baseKeys = parseApiKeys(apiKeys);

  return async function handleRequest(request, context = {}) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);
      const activeFetch = context.fetchImpl || fetchImpl;
      const activeConsumedTx = context.consumedTxHashes || consumedTxHashes;

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse(
          200,
          {
            status: "ok",
            service: "aegisgate",
            version: openapiSpec.info.version,
            treasury: TREASURY_ADDRESS,
            chains: Object.keys(CANONICAL_CHAINS)
          },
          { "Cache-Control": "no-store" }
        );
      }

      if (request.method === "GET" && url.pathname === "/v1/pricing") {
        return jsonResponse(200, {
          x402_per_call_usdc: "0.01",
          b2b_plans_usdc_monthly: {
            starter: 49,
            growth: 199,
            enterprise: 499
          },
          treasury: TREASURY_ADDRESS,
          network: "base-mainnet",
          openapi: "/openapi.json"
        });
      }

      if (request.method === "GET" && (url.pathname === "/openapi.json" || url.pathname === "/v1/openapi.json")) {
        return jsonResponse(200, openapiSpec, { "Cache-Control": "public, max-age=300" });
      }

      const authorizeRequest = async (priceUnits) => {
        const apiKey = request.headers.get("x-api-key");
        const paymentTx = request.headers.get("x-payment-tx");
        const allowedKeys = resolveAllowedApiKeys(baseKeys, context);

        if (typeof apiKey === "string" && apiKey.length > 0 && allowedKeys.has(apiKey)) {
          return { ok: true, paymentReceipt: null };
        }
        if (typeof paymentTx === "string") {
          const verification = await verifyBaseUsdcPayment(
            paymentTx,
            priceUnits,
            activeConsumedTx,
            activeFetch
          );
          if (!verification.ok) {
            return {
              ok: false,
              response: jsonResponse(
                402,
                {
                  ...build402Payload(priceUnits, url.pathname),
                  paymentError: verification.reason
                },
                { "Cache-Control": "no-store" }
              )
            };
          }
          return { ok: true, paymentReceipt: verification };
        }
        return {
          ok: false,
          response: jsonResponse(
            402,
            build402Payload(priceUnits, url.pathname),
            { "Cache-Control": "no-store" }
          )
        };
      };

      if (request.method === "GET" && url.pathname === "/v1/screen") {
        const address = url.searchParams.get("address") || "";
        const chain = url.searchParams.get("chain") || "base";

        const auth = await authorizeRequest(PRICE_PER_SCREEN_USDC_UNITS);
        if (!auth.ok) return auth.response;

        const report = await screenEvmAddress(address, chain, activeFetch);
        return jsonResponse(200, { report, paymentReceipt: auth.paymentReceipt }, { "Cache-Control": "no-store" });
      }

      if (request.method === "POST" && url.pathname === "/v1/screen/batch") {
        const auth = await authorizeRequest(PRICE_PER_BATCH_USDC_UNITS);
        if (!auth.ok) return auth.response;

        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse(400, { error: "Invalid JSON body" });
        }

        const addresses = Array.isArray(body?.addresses) ? body.addresses : null;
        const chain = typeof body?.chain === "string" && body.chain.trim() ? body.chain.trim().toLowerCase() : "base";
        if (!addresses || addresses.length === 0 || addresses.length > MAX_BATCH_ADDRESSES) {
          return jsonResponse(400, {
            error: `addresses must be a non-empty array of 1 to ${MAX_BATCH_ADDRESSES} EVM addresses`
          });
        }

        const results = await Promise.all(
          addresses.map((addr) => screenEvmAddress(String(addr || ""), chain, activeFetch))
        );
        const blockedCount = results.filter((r) => r.verdict === "BLOCK").length;
        const reviewCount = results.filter((r) => r.verdict === "REVIEW").length;
        const allowCount = results.filter((r) => r.verdict === "ALLOW").length;

        return jsonResponse(
          200,
          {
            chain,
            total: results.length,
            blockedCount,
            reviewCount,
            allowCount,
            results,
            paymentReceipt: auth.paymentReceipt
          },
          { "Cache-Control": "no-store" }
        );
      }

      if (request.method === "GET") {
        const assetRes = await tryServeStaticAsset(request, context);
        if (assetRes) return assetRes;

        if (url.pathname === "/" || url.pathname === "/index.html") {
          const html = context.landingHtml ?? landingHtml ?? FALLBACK_LANDING_HTML;
          return new Response(html, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              ...CORS_HEADERS
            }
          });
        }
      }

      return jsonResponse(404, { error: "Not Found" });
    } catch (err) {
      return jsonResponse(400, { error: err?.message || "Bad Request" });
    }
  };
}

/**
 * Venture Engine Unified Portal — Shared Web Fetch Request Handler
 * Pure Web Standard APIs (zero node:* imports); shared across Cloudflare Workers and Node.js.
 */
import x402Manifest from "../public/.well-known/x402.json" with { type: "json" };
import openapiSpec from "../public/openapi.json" with { type: "json" };
import {
  TREASURY_ADDRESS,
  BASE_USDC_ADDRESS,
  BASE_CHAIN_ID,
  BASE_NETWORK,
  BASE_RPC_URL,
  B2B_PLANS,
  createBoundedReplayStore,
  createBoundedInvoiceStore,
  validateKybSubmission,
  computeDeterministicInvoiceId,
  isValidInvoiceId,
  buildInvoiceRecord,
  verifyBaseUsdcPayment,
  screenPayerAddress
} from "./kyb_gate.mjs";

export const MAX_JSON_BODY_BYTES = 16384;

export const CORS_HEADERS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, X-Payment-Tx"
});

const FALLBACK_LLMS_TXT = `# Venture Engine B2B FinTech & Risk Suite

> Zero-dependency serverless APIs + stdio MCP servers for AI agents, DeFi protocols, and Web3 payment rails across Base, Ethereum, and Arbitrum. Pay per call via x402 Base Mainnet USDC or onboard via Fail-Closed KYB self-serve B2B plans.

## Settlement & Compliance
- Receive-Only Treasury: ${TREASURY_ADDRESS}
- Payment Asset: Base Mainnet USDC (${BASE_USDC_ADDRESS}, chainId ${BASE_CHAIN_ID}, 6 decimals)
- Compliance Gate: Fail-Closed OFAC SDN, Rosfinmonitoring, mixer/darknet, prohibited jurisdiction, and non-defense screening
- Discovery Manifests: /.well-known/x402.json | /openapi.json | /v1/plans | /health

## Unified B2B Monthly Plans (Base USDC)
- Starter: $49/mo (49000000 units) — 25,000 combined calls/mo across AegisGate, GasPulse, AuditPulse
- Growth: $199/mo (199000000 units) — 150,000 combined calls/mo + webhook diffs & priority routing
- Enterprise: $499/mo (499000000 units) — 1,000,000 combined calls/mo + dedicated B2B multi-seat SLA

## Self-Serve KYB Checkout Flow
1. POST /v1/kyb-checkout with JSON: { companyName, jurisdiction, contactDomain, payerAddress, plan }
2. POST /v1/kyb-checkout (with invoiceId + txHash) or POST /v1/verify-invoice to verify Base USDC payment.
`;

const FALLBACK_LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Venture Engine — Self-Serve EVM Risk, Gas &amp; Invariant API Portal</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #070b14; color: #e2e8f0; margin: 0; padding: 2rem; line-height: 1.5; }
    main { max-width: 780px; margin: 0 auto; }
    code, a { color: #38bdf8; }
  </style>
</head>
<body>
  <main>
    <h1>Venture Engine Portal</h1>
    <p>Zero-call self-serve B2B onboarding and Fail-Closed KYB/AML gate for AegisGate, GasPulse, and AuditPulse.</p>
    <ul>
      <li><a href="/health">/health</a></li>
      <li><a href="/v1/plans">/v1/plans</a></li>
      <li><a href="/.well-known/x402.json">/.well-known/x402.json</a></li>
      <li><a href="/llms.txt">/llms.txt</a></li>
      <li><a href="/openapi.json">/openapi.json</a></li>
      <li><code>POST /v1/kyb-checkout</code> &middot; <code>POST /v1/verify-invoice</code></li>
    </ul>
    <p>Receive-only Base Mainnet USDC treasury: <code>${TREASURY_ADDRESS}</code></p>
  </main>
</body>
</html>`;

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

function errorResponse(status, code, error, extra = {}) {
  return jsonResponse(
    status,
    {
      ok: false,
      code,
      error,
      ...extra
    },
    { "Cache-Control": "no-store" }
  );
}

async function readJsonBody(request, maxBytes = MAX_JSON_BODY_BYTES) {
  const rawText = await request.text();
  const byteLength = new TextEncoder().encode(rawText).byteLength;
  if (byteLength > maxBytes) {
    return {
      ok: false,
      httpStatus: 413,
      code: "PAYLOAD_TOO_LARGE",
      error: `Request body exceeds ${maxBytes} byte limit`
    };
  }
  if (!rawText.trim()) {
    return { ok: false, httpStatus: 400, code: "EMPTY_BODY", error: "JSON request body is required" };
  }
  try {
    const data = JSON.parse(rawText);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, httpStatus: 400, code: "INVALID_PAYLOAD", error: "Request body must be a JSON object" };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, httpStatus: 400, code: "INVALID_JSON", error: "Malformed JSON request body" };
  }
}

async function tryServeStaticAsset(request, context) {
  const assets = context.env?.ASSETS;
  if (!assets || typeof assets.fetch !== "function") return null;
  const assetRes = await assets.fetch(request);
  if (!assetRes || assetRes.status === 404) return null;
  return assetRes;
}

function buildEntitlement(invoice) {
  return {
    status: "ACTIVE",
    invoiceId: invoice.invoiceId,
    plan: invoice.plan,
    planName: invoice.planName,
    monthlyQuota: invoice.monthlyQuota,
    apis: invoice.includes,
    companyName: invoice.companyName,
    jurisdiction: invoice.jurisdiction,
    contactDomain: invoice.contactDomain,
    payerAddress: invoice.payerAddress,
    settlementAsset: BASE_USDC_ADDRESS,
    treasury: TREASURY_ADDRESS
  };
}

function buildVerificationErrorResponse(verification, kybStatus = "APPROVED") {
  const isBlocked = verification.httpStatus === 403;
  return errorResponse(verification.httpStatus || 402, verification.reason, verification.detail || verification.reason, {
    kybStatus: isBlocked ? "REJECTED" : kybStatus,
    paymentStatus: isBlocked ? "BLOCKED" : "FAILED",
    ...(verification.payerAddress ? { payerAddress: verification.payerAddress } : {}),
    ...(verification.transferredUnits ? { transferredUnits: verification.transferredUnits } : {}),
    ...(verification.requiredUnits ? { requiredUnits: verification.requiredUnits } : {})
  });
}

async function handleKybCheckout(payload, { fetchImpl, consumedTxHashes, issuedInvoices, rpcUrl }) {
  const kybResult = validateKybSubmission(payload);
  if (!kybResult.ok) {
    return errorResponse(kybResult.httpStatus, kybResult.code, kybResult.error, {
      kybStatus: kybResult.kybStatus,
      paymentStatus: "NOT_STARTED"
    });
  }

  const invoiceId = await computeDeterministicInvoiceId(kybResult.normalized, kybResult.planConfig);
  const invoice = buildInvoiceRecord(invoiceId, kybResult);
  if (!issuedInvoices.has(invoiceId)) {
    issuedInvoices.set(invoiceId, { ...invoice, kybStatus: "APPROVED", paymentStatus: "AWAITING_PAYMENT" });
  }

  const rawTxHash = typeof payload.txHash === "string" ? payload.txHash.trim() : "";
  if (!rawTxHash) {
    return jsonResponse(
      200,
      {
        ok: true,
        status: "INVOICE_ISSUED",
        kybStatus: "APPROVED",
        paymentStatus: "AWAITING_PAYMENT",
        invoice,
        paymentReceipt: null,
        entitlement: null,
        kybChecks: kybResult.checks
      },
      { "Cache-Control": "no-store" }
    );
  }

  if (payload.invoiceId !== undefined && payload.invoiceId !== null && payload.invoiceId !== "") {
    if (!isValidInvoiceId(payload.invoiceId)) {
      return errorResponse(400, "INVALID_INVOICE_ID", "invoiceId must match inv_<24 hex chars>");
    }
    if (payload.invoiceId !== invoiceId) {
      return errorResponse(400, "INVOICE_ID_MISMATCH", "Provided invoiceId does not match KYB submission parameters", {
        expectedInvoiceId: invoiceId
      });
    }
  }

  const verification = await verifyBaseUsdcPayment(
    rawTxHash,
    BigInt(invoice.amountUnits),
    consumedTxHashes,
    fetchImpl,
    { rpcUrl, expectedPayerAddress: invoice.payerAddress }
  );
  if (!verification.ok) {
    return buildVerificationErrorResponse(verification, "APPROVED");
  }

  issuedInvoices.set(invoiceId, {
    ...invoice,
    kybStatus: "VERIFIED",
    paymentStatus: "CONFIRMED",
    paidTxHash: verification.txHash
  });

  return jsonResponse(
    200,
    {
      ok: true,
      status: "PAID_AND_VERIFIED",
      kybStatus: "VERIFIED",
      paymentStatus: "CONFIRMED",
      invoice,
      paymentReceipt: verification,
      entitlement: buildEntitlement(invoice)
    },
    { "Cache-Control": "no-store" }
  );
}

async function handleVerifyInvoice(payload, { fetchImpl, consumedTxHashes, issuedInvoices, rpcUrl }) {
  if (payload.invoiceId !== undefined && payload.invoiceId !== null && payload.invoiceId !== "") {
    if (!isValidInvoiceId(payload.invoiceId)) {
      return errorResponse(400, "INVALID_INVOICE_ID", "invoiceId must match inv_<24 hex chars>");
    }
  }

  const rawTxHash = typeof payload.txHash === "string" ? payload.txHash.trim() : "";
  if (!rawTxHash) {
    return errorResponse(400, "MISSING_TX_HASH", "txHash is required for invoice verification");
  }

  const hasKybFields =
    payload.companyName !== undefined ||
    payload.jurisdiction !== undefined ||
    payload.contactDomain !== undefined;

  if (hasKybFields) {
    return handleKybCheckout(payload, { fetchImpl, consumedTxHashes, issuedInvoices, rpcUrl });
  }

  const existingInvoice = payload.invoiceId ? issuedInvoices.get(payload.invoiceId) : null;
  if (existingInvoice) {
    if (payload.plan && String(payload.plan).trim().toLowerCase() !== existingInvoice.plan) {
      return errorResponse(400, "PLAN_MISMATCH", "Provided plan does not match issued invoice plan");
    }
    if (payload.payerAddress !== undefined && payload.payerAddress !== null && payload.payerAddress !== "") {
      const payerCheck = screenPayerAddress(payload.payerAddress);
      if (!payerCheck.ok) {
        return errorResponse(payerCheck.httpStatus, payerCheck.code, payerCheck.error, {
          kybStatus: payerCheck.httpStatus === 403 ? "REJECTED" : "INVALID_INPUT",
          paymentStatus: "BLOCKED"
        });
      }
      if (payerCheck.normalized !== existingInvoice.payerAddress) {
        return errorResponse(403, "PAYER_MISMATCH", "Provided payerAddress does not match issued invoice payer", {
          kybStatus: "REJECTED",
          paymentStatus: "BLOCKED"
        });
      }
    }
    const verification = await verifyBaseUsdcPayment(
      rawTxHash,
      BigInt(existingInvoice.amountUnits),
      consumedTxHashes,
      fetchImpl,
      { rpcUrl, expectedPayerAddress: existingInvoice.payerAddress }
    );
    if (!verification.ok) {
      return buildVerificationErrorResponse(verification, existingInvoice.kybStatus || "APPROVED");
    }
    issuedInvoices.set(existingInvoice.invoiceId, {
      ...existingInvoice,
      kybStatus: "VERIFIED",
      paymentStatus: "CONFIRMED",
      paidTxHash: verification.txHash
    });
    return jsonResponse(
      200,
      {
        ok: true,
        status: "PAID_AND_VERIFIED",
        kybStatus: "VERIFIED",
        paymentStatus: "CONFIRMED",
        invoice: existingInvoice,
        paymentReceipt: verification,
        entitlement: buildEntitlement(existingInvoice)
      },
      { "Cache-Control": "no-store" }
    );
  }

  // Stateless receipt verification path when caller supplies plan or amountUnits without prior isolate state
  const planKey = typeof payload.plan === "string" ? payload.plan.trim().toLowerCase() : "";
  const planConfig = planKey ? B2B_PLANS[planKey] : null;
  if (planKey && !planConfig) {
    return errorResponse(400, "INVALID_PLAN", "plan must be one of: starter, growth, enterprise");
  }

  let requiredUnits = null;
  if (planConfig) {
    requiredUnits = BigInt(planConfig.amountUnits);
  } else if (payload.amountUnits !== undefined && /^\d+$/.test(String(payload.amountUnits))) {
    const parsed = BigInt(String(payload.amountUnits));
    if (parsed > 0n) requiredUnits = parsed;
  }

  if (!requiredUnits) {
    return errorResponse(
      400,
      "MISSING_INVOICE_OR_PLAN",
      "Provide a known invoiceId, full KYB fields, or a valid plan (starter|growth|enterprise)"
    );
  }

  let expectedPayerAddress = null;
  if (payload.payerAddress !== undefined && payload.payerAddress !== null && payload.payerAddress !== "") {
    const payerCheck = screenPayerAddress(payload.payerAddress);
    if (!payerCheck.ok) {
      return errorResponse(payerCheck.httpStatus, payerCheck.code, payerCheck.error, {
        kybStatus: payerCheck.httpStatus === 403 ? "REJECTED" : "INVALID_INPUT",
        paymentStatus: "BLOCKED"
      });
    }
    expectedPayerAddress = payerCheck.normalized;
  }

  const verification = await verifyBaseUsdcPayment(rawTxHash, requiredUnits, consumedTxHashes, fetchImpl, {
    rpcUrl,
    expectedPayerAddress
  });
  if (!verification.ok) {
    return buildVerificationErrorResponse(verification, "NOT_SUBMITTED");
  }

  return jsonResponse(
    200,
    {
      ok: true,
      status: "PAYMENT_VERIFIED",
      kybStatus: "NOT_SUBMITTED",
      paymentStatus: "CONFIRMED",
      invoice: {
        invoiceId: payload.invoiceId || null,
        plan: planConfig?.id || null,
        amountUnits: requiredUnits.toString(),
        payTo: TREASURY_ADDRESS,
        asset: BASE_USDC_ADDRESS,
        chainId: BASE_CHAIN_ID,
        network: BASE_NETWORK,
        receiveOnly: true
      },
      paymentReceipt: verification,
      entitlement: null
    },
    { "Cache-Control": "no-store" }
  );
}

/**
 * Creates a Web-standard Request -> Response handler shared by Node, Cloudflare Workers, and Edge runtimes.
 */
export function createPortalHandler({
  fetchImpl = fetch,
  consumedTxHashes = createBoundedReplayStore(),
  issuedInvoices = createBoundedInvoiceStore(),
  landingHtml = null,
  llmsTxt = null,
  rpcUrl = BASE_RPC_URL
} = {}) {
  return async function handleRequest(request, context = {}) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);
      const activeFetch = context.fetchImpl || fetchImpl;
      const activeConsumedTx = context.consumedTxHashes || consumedTxHashes;
      const activeInvoices = context.issuedInvoices || issuedInvoices;
      const activeRpcUrl = context.rpcUrl || context.env?.BASE_RPC_URL || rpcUrl;

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse(
          200,
          {
            status: "ok",
            service: "venture-engine-portal",
            version: openapiSpec.info.version,
            treasury: TREASURY_ADDRESS,
            network: BASE_NETWORK,
            chainId: BASE_CHAIN_ID,
            receiveOnly: true,
            plans: Object.keys(B2B_PLANS)
          },
          { "Cache-Control": "no-store" }
        );
      }

      if (request.method === "GET" && url.pathname === "/v1/plans") {
        return jsonResponse(
          200,
          {
            suite: x402Manifest.suite,
            treasury: x402Manifest.treasury,
            onboarding: x402Manifest.onboarding,
            plans: x402Manifest.b2bPlansMonthlyUsdc,
            services: x402Manifest.services
          },
          { "Cache-Control": "public, max-age=300" }
        );
      }

      if (request.method === "GET" && url.pathname === "/.well-known/x402.json") {
        return jsonResponse(200, x402Manifest, { "Cache-Control": "public, max-age=300" });
      }

      if (request.method === "GET" && (url.pathname === "/openapi.json" || url.pathname === "/v1/openapi.json")) {
        return jsonResponse(200, openapiSpec, { "Cache-Control": "public, max-age=300" });
      }

      if (request.method === "GET" && url.pathname === "/llms.txt") {
        const assetRes = await tryServeStaticAsset(request, context);
        if (assetRes) return assetRes;
        const body = context.llmsTxt ?? llmsTxt ?? FALLBACK_LLMS_TXT;
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            ...CORS_HEADERS
          }
        });
      }

      if (url.pathname === "/v1/kyb-checkout") {
        if (request.method !== "POST") {
          return errorResponse(405, "METHOD_NOT_ALLOWED", "Use POST for /v1/kyb-checkout", { Allow: "POST, OPTIONS" });
        }
        const parsed = await readJsonBody(request);
        if (!parsed.ok) {
          return errorResponse(parsed.httpStatus, parsed.code, parsed.error);
        }
        return handleKybCheckout(parsed.data, {
          fetchImpl: activeFetch,
          consumedTxHashes: activeConsumedTx,
          issuedInvoices: activeInvoices,
          rpcUrl: activeRpcUrl
        });
      }

      if (url.pathname === "/v1/verify-invoice") {
        if (request.method !== "POST") {
          return errorResponse(405, "METHOD_NOT_ALLOWED", "Use POST for /v1/verify-invoice", { Allow: "POST, OPTIONS" });
        }
        const parsed = await readJsonBody(request);
        if (!parsed.ok) {
          return errorResponse(parsed.httpStatus, parsed.code, parsed.error);
        }
        return handleVerifyInvoice(parsed.data, {
          fetchImpl: activeFetch,
          consumedTxHashes: activeConsumedTx,
          issuedInvoices: activeInvoices,
          rpcUrl: activeRpcUrl
        });
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

      return errorResponse(404, "NOT_FOUND", "Not Found");
    } catch (err) {
      return errorResponse(400, "BAD_REQUEST", err?.message || "Bad Request");
    }
  };
}

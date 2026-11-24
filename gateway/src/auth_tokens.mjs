/**
 * Stateless Web Crypto (crypto.subtle) HMAC-SHA256 B2B API Token Issuer & Constant-Time Verifier.
 * Format: ve_live_<base64url(payloadJson)>.<base64url(hmacSha256)>
 * Zero node:* imports and zero hardcoded fallback secrets (Fail-Closed).
 */

export const TOKEN_PREFIX = "ve_live_";
export const DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const VALID_PLANS = new Set(["starter", "growth", "enterprise"]);
const INVOICE_ID_RE = /^inv_[0-9a-f]{24}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(str) {
  if (typeof str !== "string" || !str || !BASE64URL_RE.test(str)) {
    return null;
  }
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Constant-time byte comparison avoiding early exit on mismatch.
 */
export function constantTimeEqualBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

export function constantTimeEqualStrings(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return constantTimeEqualBytes(textEncoder.encode(a), textEncoder.encode(b));
}

async function importHmacKey(secret, usage) {
  if (typeof secret !== "string" || !secret.trim()) {
    return null;
  }
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

/**
 * Issues a signed `ve_live_<payload>.<sig>` token for a KYB-verified & settled invoice.
 * Returns null if `secret` is not configured (never invents a fallback secret).
 */
export async function issueApiToken(
  { plan, invoiceId, payerAddress, kybStatus = "VERIFIED", ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS, nowMs = Date.now() },
  secret
) {
  const key = await importHmacKey(secret, "sign");
  if (!key) return null;

  const normalizedPlan = typeof plan === "string" ? plan.trim().toLowerCase() : "";
  if (!VALID_PLANS.has(normalizedPlan)) {
    throw new Error("Invalid plan for token issuance");
  }
  if (!INVOICE_ID_RE.test(String(invoiceId || ""))) {
    throw new Error("Invalid invoiceId for token issuance");
  }
  if (!EVM_ADDRESS_RE.test(String(payerAddress || ""))) {
    throw new Error("Invalid payerAddress for token issuance");
  }
  if (kybStatus !== "VERIFIED") {
    throw new Error("Cannot issue API token without VERIFIED kybStatus");
  }

  const iat = Math.floor(nowMs / 1000);
  const exp = iat + Math.max(1, Math.floor(Number(ttlSeconds) || DEFAULT_TOKEN_TTL_SECONDS));
  const payload = {
    v: 1,
    plan: normalizedPlan,
    invoiceId,
    payerAddress: payerAddress.toLowerCase(),
    kybStatus: "VERIFIED",
    iat,
    exp
  };

  const payloadB64 = bytesToBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const signingInput = `${TOKEN_PREFIX}${payloadB64}`;
  const sigBuffer = await crypto.subtle.sign("HMAC", key, textEncoder.encode(signingInput));
  const sigB64 = bytesToBase64Url(new Uint8Array(sigBuffer));

  return {
    token: `${signingInput}.${sigB64}`,
    claims: payload
  };
}

/**
 * Verifies a `ve_live_<payload>.<sig>` token via constant-time HMAC-SHA256 comparison.
 */
export async function verifyApiToken(token, secret, { nowMs = Date.now() } = {}) {
  if (typeof secret !== "string" || !secret.trim()) {
    return { ok: false, reason: "TOKEN_SECRET_NOT_CONFIGURED" };
  }
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
    return { ok: false, reason: "INVALID_TOKEN_FORMAT" };
  }

  const remainder = token.slice(TOKEN_PREFIX.length);
  const parts = remainder.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "INVALID_TOKEN_FORMAT" };
  }

  const [payloadB64, sigB64] = parts;
  const payloadBytes = base64UrlToBytes(payloadB64);
  const sigBytes = base64UrlToBytes(sigB64);
  if (!payloadBytes || !sigBytes || sigBytes.length !== 32) {
    return { ok: false, reason: "INVALID_TOKEN_ENCODING" };
  }

  const key = await importHmacKey(secret, "sign");
  const signingInput = `${TOKEN_PREFIX}${payloadB64}`;
  const expectedSigBuffer = await crypto.subtle.sign("HMAC", key, textEncoder.encode(signingInput));
  const expectedSigBytes = new Uint8Array(expectedSigBuffer);

  if (!constantTimeEqualBytes(sigBytes, expectedSigBytes)) {
    return { ok: false, reason: "INVALID_TOKEN_SIGNATURE" };
  }

  let claims;
  try {
    claims = JSON.parse(textDecoder.decode(payloadBytes));
  } catch {
    return { ok: false, reason: "INVALID_TOKEN_PAYLOAD" };
  }

  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    return { ok: false, reason: "INVALID_TOKEN_PAYLOAD" };
  }
  if (
    !VALID_PLANS.has(claims.plan) ||
    !INVOICE_ID_RE.test(String(claims.invoiceId || "")) ||
    !EVM_ADDRESS_RE.test(String(claims.payerAddress || "")) ||
    claims.kybStatus !== "VERIFIED"
  ) {
    return { ok: false, reason: "INVALID_TOKEN_CLAIMS" };
  }

  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.exp <= claims.iat) {
    return { ok: false, reason: "INVALID_TOKEN_TIMESTAMPS" };
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (claims.iat > nowSec + 60) {
    return { ok: false, reason: "TOKEN_NOT_YET_VALID" };
  }
  if (nowSec >= claims.exp) {
    return { ok: false, reason: "TOKEN_EXPIRED" };
  }

  return {
    ok: true,
    claims: {
      ...claims,
      payerAddress: claims.payerAddress.toLowerCase()
    }
  };
}

export function parseStaticKeySet(...sources) {
  const merged = new Set();
  for (const src of sources) {
    if (!src) continue;
    if (src instanceof Set || Array.isArray(src)) {
      for (const item of src) {
        const trimmed = String(item).trim();
        if (trimmed) merged.add(trimmed);
      }
    } else if (typeof src === "string") {
      for (const item of src.split(",")) {
        const trimmed = item.trim();
        if (trimmed) merged.add(trimmed);
      }
    }
  }
  return merged;
}

/**
 * Authenticates an X-Api-Key header against stateless HMAC tokens or configured static B2B keys.
 */
export async function authenticateApiKeyHeader(
  rawHeaderValue,
  { tokenSecret = "", staticKeys = new Set(), forbiddenKey = null, nowMs = Date.now() } = {}
) {
  if (typeof rawHeaderValue !== "string" || !rawHeaderValue.trim()) {
    return { provided: false, ok: false };
  }

  const candidate = rawHeaderValue.trim();
  if (forbiddenKey && constantTimeEqualStrings(candidate, forbiddenKey)) {
    return { provided: true, ok: false, status: 401, reason: "INVALID_API_KEY" };
  }

  if (candidate.startsWith(TOKEN_PREFIX)) {
    const verified = await verifyApiToken(candidate, tokenSecret, { nowMs });
    if (!verified.ok) {
      return { provided: true, ok: false, status: 401, reason: verified.reason };
    }
    return {
      provided: true,
      ok: true,
      method: "hmac-token",
      claims: verified.claims
    };
  }

  let matchedStatic = false;
  for (const allowedKey of staticKeys) {
    if (constantTimeEqualStrings(candidate, allowedKey)) {
      matchedStatic = true;
    }
  }
  if (matchedStatic) {
    return { provided: true, ok: true, method: "static-key", claims: null };
  }

  return { provided: true, ok: false, status: 401, reason: "INVALID_API_KEY" };
}

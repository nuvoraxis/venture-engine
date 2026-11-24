/**
 * Venture Engine Portal — Fail-Closed KYB / AML Gate & Base USDC Settlement Verifier
 * Zero external or node:* dependencies; safe for Cloudflare Workers, Edge runtimes, and Node.js.
 */

export const TREASURY_ADDRESS = "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c";
export const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const BASE_CHAIN_ID = 8453;
export const BASE_NETWORK = "base-mainnet";
export const BASE_RPC_URL = "https://mainnet.base.org";
// keccak256("Transfer(address,address,uint256)")
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const B2B_PLANS = Object.freeze({
  starter: Object.freeze({
    id: "starter",
    name: "Starter",
    priceUsdc: 49,
    amountUnits: "49000000",
    monthlyQuota: 25000,
    includes: Object.freeze(["aegisgate", "gaspulse", "auditpulse"])
  }),
  growth: Object.freeze({
    id: "growth",
    name: "Growth",
    priceUsdc: 199,
    amountUnits: "199000000",
    monthlyQuota: 150000,
    includes: Object.freeze(["aegisgate", "gaspulse", "auditpulse"])
  }),
  enterprise: Object.freeze({
    id: "enterprise",
    name: "Enterprise",
    priceUsdc: 499,
    amountUnits: "499000000",
    monthlyQuota: 1000000,
    includes: Object.freeze(["aegisgate", "gaspulse", "auditpulse"])
  })
});

// Public OFAC SDN / Tornado Cash / exploiter contracts (lowercase)
export const SANCTIONED_OR_MIXER_ADDRESSES = new Map([
  ["0x8589427373d6d84e98730d7795d8f6f8731fda16", { category: "MIXER_OFAC", label: "Tornado Cash: Router" }],
  ["0xd90e2f925da726b50c4ed8d0fb90ad053324f31b", { category: "MIXER_OFAC", label: "Tornado Cash: Router (Legacy)" }],
  ["0x722122df12d4e14e13ac3b6895a86e84145b6967", { category: "MIXER_OFAC", label: "Tornado Cash: Proxy" }],
  ["0xdd4c48c0b24039969fc16d1cdf626eab821d3384", { category: "MIXER_OFAC", label: "Tornado Cash: 0.1 ETH" }],
  ["0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc", { category: "MIXER_OFAC", label: "Tornado Cash: 0.1 ETH Pool" }],
  ["0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936", { category: "MIXER_OFAC", label: "Tornado Cash: 1 ETH Pool" }],
  ["0x910cbd523d972eb0a6f4cae4618ad62622b39dbf", { category: "MIXER_OFAC", label: "Tornado Cash: 10 ETH" }],
  ["0xa160cdab225685da1d56aa342ad8841c3b53f291", { category: "MIXER_OFAC", label: "Tornado Cash: 100 ETH" }],
  ["0x098b716b8aaf21512996dc57eb0615e2383e2f96", { category: "EXPLOIT_OFAC", label: "Lazarus Group: Ronin Exploiter" }],
  ["0x0000000000000000000000000000000000000000", { category: "INVALID_BURN_ADDRESS", label: "Zero Burn Address" }]
]);

// Comprehensively sanctioned, FATF high-risk, and unassigned/anonymous ISO-2 codes (Fail-Closed)
export const PROHIBITED_JURISDICTIONS = new Set([
  "KP", "IR", "SY", "CU", "MM", "AF", "BY", "VE",
  "SD", "SS", "SO", "YE", "LY", "CF", "CD", "IQ",
  "LB", "ZW", "XX", "ZZ", "XZ", "AQ", "UN"
]);

export const DARKNET_TLDS = new Set(["onion", "i2p", "loki", "bit"]);
export const INTERNAL_TLDS = new Set(["local", "internal", "localhost", "arpa", "lan", "home", "invalid"]);

// Free consumer webmail & disposable/anonymous domain suffixes rejected for B2B KYB
export const DISPOSABLE_OR_CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "mail.ru",
  "bk.ru",
  "inbox.ru",
  "list.ru",
  "yandex.ru",
  "yandex.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "tutanota.com",
  "tuta.io",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.org",
  "sharklasers.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
  "throwawaymail.com",
  "trashmail.com",
  "getnada.com",
  "dispostable.com",
  "anonaddy.me",
  "simplelogin.com",
  "duck.com",
  "cock.li",
  "dnmx.org",
  "elude.in"
]);

const DISPOSABLE_LABEL_RE =
  /^(tempmail|temp-mail|throwaway|disposable|guerrillamail|mailinator|10minutemail|yopmail|trashmail|darknet)$/i;

const ANONYMOUS_ENTITY_RE =
  /\b(anonymous|anon|unverified|no[- ]?kyc|shell\s+company|front\s+company|incognito|redacted|unknown)\b/i;

const EXACT_PLACEHOLDER_ENTITY_RE = /^(n\/a|na|none|null|undefined|-+)$/i;

const PROHIBITED_ACTIVITY_RE =
  /\b(tornado\s*cash|chipmixer|blender\.io|sinbad|garantex|lazarus\s*group|hydra|alphabay|silk\s*road|darknet|darkweb|ransomware|carding|stealer|exploit\s*kit|defense|defence|military|weapons?|munitions?|missiles?|armaments?|espionage|cyberwarfare|spyware|mercenary|terrorist|extremist|al[- ]?qaeda|isis|isil|hamas|hezbollah|taliban|wagner|ofac\s*sdn|undesirable\s*organization|foreign\s*agent)\b/i;

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const INVOICE_ID_RE = /^inv_[0-9a-f]{24}$/;
const DNS_DOMAIN_RE =
  /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function evictOldestIfFull(collection, maxEntries) {
  if (collection.size < maxEntries) return;
  const oldest = collection.values().next().value;
  collection.delete(oldest);
}

/**
 * Bounded FIFO replay-protection set keeping isolate memory usage capped (<1 MB).
 */
export function createBoundedReplayStore(maxEntries = 10000) {
  const entries = new Set();
  return {
    has(txHash) {
      return entries.has(String(txHash).toLowerCase());
    },
    add(txHash) {
      const normalized = String(txHash).toLowerCase();
      if (entries.has(normalized)) return this;
      evictOldestIfFull(entries, maxEntries);
      entries.add(normalized);
      return this;
    },
    get size() {
      return entries.size;
    }
  };
}

/**
 * Bounded FIFO invoice store retaining KYB-approved invoices in isolate memory.
 */
export function createBoundedInvoiceStore(maxEntries = 10000) {
  const invoices = new Map();
  return {
    has(invoiceId) {
      return invoices.has(invoiceId);
    },
    get(invoiceId) {
      return invoices.get(invoiceId) || null;
    },
    set(invoiceId, record) {
      if (!invoices.has(invoiceId)) {
        evictOldestIfFull(invoices, maxEntries);
      }
      invoices.set(invoiceId, record);
      return this;
    },
    get size() {
      return invoices.size;
    }
  };
}

function kybFail(httpStatus, code, error, extra = {}) {
  return {
    ok: false,
    httpStatus,
    kybStatus: httpStatus === 403 ? "REJECTED" : "INVALID_INPUT",
    code,
    error,
    ...extra
  };
}

function checkCorporateDomain(rawDomain) {
  if (typeof rawDomain !== "string") {
    return kybFail(400, "INVALID_CONTACT_DOMAIN", "contactDomain must be a corporate DNS domain string");
  }
  const normalized = rawDomain.trim().toLowerCase().replace(/\.$/, "");
  if (
    !normalized ||
    normalized.includes("@") ||
    normalized.includes("://") ||
    normalized.includes("/") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(normalized) ||
    !DNS_DOMAIN_RE.test(normalized)
  ) {
    return kybFail(400, "INVALID_CONTACT_DOMAIN", "contactDomain must be a valid corporate DNS hostname");
  }

  const labels = normalized.split(".");
  const tld = labels[labels.length - 1];
  if (tld.length < 2 || /^\d+$/.test(tld)) {
    return kybFail(400, "INVALID_CONTACT_DOMAIN", "contactDomain has an invalid top-level domain");
  }
  if (DARKNET_TLDS.has(tld)) {
    return kybFail(403, "PROHIBITED_DARKNET_DOMAIN", `Darknet TLD '.${tld}' is prohibited`);
  }
  if (INTERNAL_TLDS.has(tld)) {
    return kybFail(400, "INVALID_CONTACT_DOMAIN", `Internal/reserved TLD '.${tld}' is not a valid corporate domain`);
  }

  for (let i = 0; i < labels.length; i += 1) {
    const suffix = labels.slice(i).join(".");
    if (DISPOSABLE_OR_CONSUMER_DOMAINS.has(suffix)) {
      return kybFail(
        403,
        "NON_CORPORATE_OR_DISPOSABLE_DOMAIN",
        `Consumer webmail or disposable domain '${normalized}' is rejected under Fail-Closed KYB`
      );
    }
    if (i < labels.length - 1 && DISPOSABLE_LABEL_RE.test(labels[i])) {
      return kybFail(
        403,
        "NON_CORPORATE_OR_DISPOSABLE_DOMAIN",
        `Disposable or darknet domain label '${labels[i]}' is rejected`
      );
    }
  }

  return { ok: true, normalized };
}

/**
 * Screens an EVM address against local OFAC/mixer/burn lists and treasury self-send.
 */
export function screenPayerAddress(address) {
  if (typeof address !== "string" || !EVM_ADDRESS_RE.test(address.trim())) {
    return kybFail(400, "INVALID_PAYER_ADDRESS", "payerAddress must be a valid 0x-prefixed 40-hex EVM address");
  }
  const normalized = address.trim().toLowerCase();
  const sanctioned = SANCTIONED_OR_MIXER_ADDRESSES.get(normalized);
  if (sanctioned) {
    return kybFail(403, "PAYER_BLOCKED_BY_AML", `Blocked payer address (${sanctioned.category}: ${sanctioned.label})`, {
      payerAddress: normalized,
      category: sanctioned.category
    });
  }
  if (normalized === TREASURY_ADDRESS) {
    return kybFail(403, "PROHIBITED_PAYER_ADDRESS", "payerAddress cannot equal the receive-only treasury address", {
      payerAddress: normalized
    });
  }
  return { ok: true, normalized };
}

/**
 * Fail-Closed KYB/AML validator checking entity name, jurisdiction, corporate domain, useCase, plan, and payer EVM address.
 */
export function validateKybSubmission(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return kybFail(400, "INVALID_PAYLOAD", "Request body must be a JSON object");
  }

  const rawCompany = input.companyName;
  if (typeof rawCompany !== "string") {
    return kybFail(400, "INVALID_COMPANY_NAME", "companyName is required");
  }
  const companyName = rawCompany.trim().replace(/\s+/g, " ");
  if (
    companyName.length < 2 ||
    companyName.length > 160 ||
    /[\x00-\x1f\x7f]/.test(companyName) ||
    !/[a-zA-Z\p{L}]/u.test(companyName)
  ) {
    return kybFail(400, "INVALID_COMPANY_NAME", "companyName must be 2-160 printable characters containing alphabetic letters");
  }
  if (
    EVM_ADDRESS_RE.test(companyName) ||
    EXACT_PLACEHOLDER_ENTITY_RE.test(companyName) ||
    ANONYMOUS_ENTITY_RE.test(companyName)
  ) {
    return kybFail(403, "ANONYMOUS_ENTITY_REJECTED", "Anonymous or unverified corporate entities are rejected");
  }
  if (PROHIBITED_ACTIVITY_RE.test(companyName)) {
    return kybFail(
      403,
      "PROHIBITED_ENTITY_OR_ACTIVITY",
      "Entity name matched sanctioned, mixer, darknet, or prohibited defense/military keywords"
    );
  }

  if (typeof input.jurisdiction !== "string" || !/^[A-Za-z]{2}$/.test(input.jurisdiction.trim())) {
    return kybFail(400, "INVALID_JURISDICTION", "jurisdiction must be an ISO 3166-1 alpha-2 country code");
  }
  const jurisdiction = input.jurisdiction.trim().toUpperCase();
  if (PROHIBITED_JURISDICTIONS.has(jurisdiction)) {
    return kybFail(403, "PROHIBITED_JURISDICTION", `Jurisdiction '${jurisdiction}' is prohibited under sanctions/compliance policy`);
  }

  const domainCheck = checkCorporateDomain(input.contactDomain);
  if (!domainCheck.ok) {
    return domainCheck;
  }

  const payerCheck = screenPayerAddress(input.payerAddress);
  if (!payerCheck.ok) {
    return payerCheck;
  }

  let useCase = null;
  if (input.useCase !== undefined && input.useCase !== null && input.useCase !== "") {
    if (typeof input.useCase !== "string" || input.useCase.trim().length > 300) {
      return kybFail(400, "INVALID_USE_CASE", "useCase must be a string up to 300 characters");
    }
    useCase = input.useCase.trim();
    if (PROHIBITED_ACTIVITY_RE.test(useCase) || ANONYMOUS_ENTITY_RE.test(useCase)) {
      return kybFail(
        403,
        "PROHIBITED_USE_CASE",
        "Requested useCase violates Non-Defense, Non-Darknet, or Counterparty KYC policy"
      );
    }
  }

  const planKey = typeof input.plan === "string" ? input.plan.trim().toLowerCase() : "";
  const planConfig = B2B_PLANS[planKey];
  if (!planConfig) {
    return kybFail(400, "INVALID_PLAN", "plan must be one of: starter, growth, enterprise");
  }

  return {
    ok: true,
    kybStatus: "APPROVED",
    normalized: {
      companyName,
      jurisdiction,
      contactDomain: domainCheck.normalized,
      payerAddress: payerCheck.normalized,
      plan: planConfig.id,
      useCase
    },
    planConfig,
    checks: {
      entityVerified: true,
      jurisdictionCleared: true,
      corporateDomainCleared: true,
      payerAddressCleared: true,
      nonDefenseCleared: true
    }
  };
}

/**
 * Computes a deterministic invoice ID (`inv_<24 lowercase hex chars>`) via Web Crypto SHA-256.
 */
export async function computeDeterministicInvoiceId(normalizedKyb, planConfig) {
  const canonical = JSON.stringify({
    companyName: String(normalizedKyb.companyName || "").trim().replace(/\s+/g, " ").toLowerCase(),
    jurisdiction: String(normalizedKyb.jurisdiction || "").trim().toUpperCase(),
    contactDomain: String(normalizedKyb.contactDomain || "").trim().toLowerCase(),
    payerAddress: String(normalizedKyb.payerAddress || "").trim().toLowerCase(),
    plan: planConfig.id,
    treasury: TREASURY_ADDRESS,
    asset: BASE_USDC_ADDRESS,
    amountUnits: planConfig.amountUnits
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `inv_${hex.slice(0, 24)}`;
}

export function isValidInvoiceId(invoiceId) {
  return typeof invoiceId === "string" && INVOICE_ID_RE.test(invoiceId);
}

export function buildInvoiceRecord(invoiceId, kybResult) {
  const { normalized, planConfig } = kybResult;
  return {
    invoiceId,
    plan: planConfig.id,
    planName: planConfig.name,
    monthlyQuota: planConfig.monthlyQuota,
    includes: [...planConfig.includes],
    network: BASE_NETWORK,
    chainId: BASE_CHAIN_ID,
    asset: BASE_USDC_ADDRESS,
    symbol: "USDC",
    decimals: 6,
    priceUsdc: planConfig.priceUsdc,
    amountUnits: planConfig.amountUnits,
    payTo: TREASURY_ADDRESS,
    receiveOnly: true,
    payerAddress: normalized.payerAddress,
    companyName: normalized.companyName,
    jurisdiction: normalized.jurisdiction,
    contactDomain: normalized.contactDomain
  };
}

/**
 * Verifies an on-chain Base Mainnet USDC Transfer receipt to TREASURY_ADDRESS with replay protection.
 */
export async function verifyBaseUsdcPayment(
  txHash,
  minAmountUnits,
  consumedTxHashes,
  fetchImpl = fetch,
  { rpcUrl = BASE_RPC_URL, expectedPayerAddress = null } = {}
) {
  if (typeof txHash !== "string" || !TX_HASH_RE.test(txHash.trim())) {
    return { ok: false, httpStatus: 400, reason: "INVALID_TX_HASH" };
  }
  const requiredUnits = BigInt(minAmountUnits);
  if (requiredUnits <= 0n) {
    return { ok: false, httpStatus: 400, reason: "INVALID_MIN_AMOUNT" };
  }
  const normalizedTx = txHash.trim().toLowerCase();
  if (consumedTxHashes.has(normalizedTx)) {
    return { ok: false, httpStatus: 402, reason: "TX_ALREADY_CONSUMED" };
  }

  let res;
  try {
    res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [normalizedTx]
      })
    });
  } catch (err) {
    return { ok: false, httpStatus: 402, reason: "RPC_UNAVAILABLE", detail: err?.message || "RPC fetch failed" };
  }

  if (!res.ok) {
    return { ok: false, httpStatus: 402, reason: `RPC_HTTP_${res.status}` };
  }

  let rpcBody;
  try {
    rpcBody = await res.json();
  } catch {
    return { ok: false, httpStatus: 402, reason: "RPC_INVALID_JSON" };
  }
  if (rpcBody?.error) {
    return { ok: false, httpStatus: 402, reason: "RPC_ERROR", detail: rpcBody.error.message || "JSON-RPC error" };
  }

  const receipt = rpcBody?.result;
  if (!receipt || typeof receipt !== "object" || receipt.status !== "0x1") {
    return { ok: false, httpStatus: 402, reason: "TX_NOT_CONFIRMED_OR_FAILED" };
  }

  const treasuryTopic = "0x" + TREASURY_ADDRESS.slice(2).padStart(64, "0");
  const candidateLogs = (Array.isArray(receipt.logs) ? receipt.logs : []).filter((log) => {
    if (!log || typeof log.address !== "string" || log.address.toLowerCase() !== BASE_USDC_ADDRESS) {
      return false;
    }
    if (!Array.isArray(log.topics) || log.topics.length < 3) return false;
    if (String(log.topics[0]).toLowerCase() !== ERC20_TRANSFER_TOPIC) return false;
    return String(log.topics[2]).toLowerCase() === treasuryTopic;
  });

  if (candidateLogs.length === 0) {
    return { ok: false, httpStatus: 402, reason: "NO_USDC_TRANSFER_TO_TREASURY" };
  }

  const parsedTransfers = [];
  for (const log of candidateLogs) {
    const rawFrom = String(log.topics[1] || "");
    if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(rawFrom)) {
      return { ok: false, httpStatus: 402, reason: "INVALID_PAYER_TOPIC" };
    }
    const rawData = typeof log.data === "string" ? log.data : "";
    if (!/^0x[0-9a-fA-F]+$/.test(rawData)) {
      return { ok: false, httpStatus: 402, reason: "INVALID_TRANSFER_LOG_DATA" };
    }
    const payerAddress = "0x" + rawFrom.slice(-40).toLowerCase();
    const payerCheck = screenPayerAddress(payerAddress);
    if (!payerCheck.ok) {
      return {
        ok: false,
        httpStatus: 403,
        reason: payerCheck.code,
        payerAddress,
        detail: payerCheck.error
      };
    }
    parsedTransfers.push({ payerAddress, transferredUnits: BigInt(rawData) });
  }

  const sufficientTransfers = parsedTransfers.filter((t) => t.transferredUnits >= requiredUnits);
  if (sufficientTransfers.length === 0) {
    const maxUnits = parsedTransfers.reduce((acc, t) => (t.transferredUnits > acc ? t.transferredUnits : acc), 0n);
    return {
      ok: false,
      httpStatus: 402,
      reason: "INSUFFICIENT_USDC_AMOUNT",
      transferredUnits: maxUnits.toString(),
      requiredUnits: requiredUnits.toString()
    };
  }

  const expectedNormalized = expectedPayerAddress ? expectedPayerAddress.toLowerCase() : null;
  const matchedTransfer = expectedNormalized
    ? sufficientTransfers.find((t) => t.payerAddress === expectedNormalized)
    : sufficientTransfers[0];

  if (!matchedTransfer) {
    return {
      ok: false,
      httpStatus: 403,
      reason: "PAYER_MISMATCH",
      expectedPayerAddress: expectedNormalized,
      actualPayerAddress: sufficientTransfers[0].payerAddress
    };
  }

  consumedTxHashes.add(normalizedTx);
  return {
    ok: true,
    txHash: normalizedTx,
    payerAddress: matchedTransfer.payerAddress,
    transferredUnits: matchedTransfer.transferredUnits.toString(),
    asset: BASE_USDC_ADDRESS,
    payTo: TREASURY_ADDRESS,
    chainId: BASE_CHAIN_ID,
    network: BASE_NETWORK,
    payerVerdict: "ALLOW",
    verifiedAt: new Date().toISOString()
  };
}

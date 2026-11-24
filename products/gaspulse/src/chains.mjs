/**
 * Canonical EVM chain configurations, compliance lists, and strict hex/address validators.
 * Zero external dependencies; safe for both Node.js and Cloudflare Workers.
 */

export const TREASURY_ADDRESS = "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c";

export const CANONICAL_CHAINS = Object.freeze({
  base: Object.freeze({
    chainId: 8453,
    name: "Base Mainnet",
    nativeSymbol: "ETH",
    blockTimeSeconds: 2,
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    rpcs: Object.freeze([
      "https://mainnet.base.org",
      "https://base.llamarpc.com",
      "https://base-rpc.publicnode.com"
    ])
  }),
  ethereum: Object.freeze({
    chainId: 1,
    name: "Ethereum Mainnet",
    nativeSymbol: "ETH",
    blockTimeSeconds: 12,
    usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    rpcs: Object.freeze([
      "https://cloudflare-eth.com",
      "https://ethereum-rpc.publicnode.com",
      "https://eth.llamarpc.com"
    ])
  }),
  arbitrum: Object.freeze({
    chainId: 42161,
    name: "Arbitrum One",
    nativeSymbol: "ETH",
    blockTimeSeconds: 0.25,
    usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    rpcs: Object.freeze([
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum-one-rpc.publicnode.com",
      "https://arbitrum.llamarpc.com"
    ])
  })
});

export const SUPPORTED_CHAIN_NAMES = Object.freeze(Object.keys(CANONICAL_CHAINS));

// Public OFAC SDN / Tornado Cash / known exploit addresses (lowercase, Fail-Closed Filter 1 & 3)
export const SANCTIONED_OR_MIXER_ADDRESSES = new Map([
  ["0x8589427373d6d84e98730d7795d8f6f8731fda16", { category: "MIXER_OFAC", label: "Tornado Cash: Router" }],
  ["0xd90e2f925da726b50c4ed8d0fb90ad053324f31b", { category: "MIXER_OFAC", label: "Tornado Cash: Router (Legacy)" }],
  ["0x722122df12d4e14e13ac3b6895a86e84145b6967", { category: "MIXER_OFAC", label: "Tornado Cash: Proxy" }],
  ["0xdd4c48c0b24039969fc16d1cdf626eab821d3384", { category: "MIXER_OFAC", label: "Tornado Cash: 0.1 ETH" }],
  ["0x910cbd523d972eb0a6f4cae4618ad62622b39dbf", { category: "MIXER_OFAC", label: "Tornado Cash: 10 ETH" }],
  ["0xa160cdab225685da1d56aa342ad8841c3b53f291", { category: "MIXER_OFAC", label: "Tornado Cash: 100 ETH" }],
  ["0x098b716b8aaf21512996dc57eb0615e2383e2f96", { category: "EXPLOIT_OFAC", label: "Lazarus Group: Ronin Exploiter" }]
]);

export function checkAddressSanctions(address) {
  if (typeof address !== "string" || !isValidEvmAddress(address)) {
    return null;
  }
  const normalized = address.toLowerCase();
  const entry = SANCTIONED_OR_MIXER_ADDRESSES.get(normalized);
  if (!entry) return null;
  return { address: normalized, ...entry };
}

export function isValidEvmAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export function isValidTxHash(hash) {
  return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash);
}

export function isValidHexBytes(data) {
  return typeof data === "string" && /^0x([0-9a-fA-F]{2})*$/.test(data);
}

export function normalizeChain(chain = "base") {
  const normalized = String(chain || "base").trim().toLowerCase();
  if (!Object.hasOwn(CANONICAL_CHAINS, normalized)) {
    throw new Error(`Unsupported chain '${chain}'. Supported: ${SUPPORTED_CHAIN_NAMES.join(", ")}`);
  }
  return normalized;
}

export function parseHexBigInt(value, fallback = 0n) {
  if (value === null || value === undefined || value === "" || value === "0x") {
    return fallback;
  }
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid numeric hex quantity: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Invalid hex quantity: ${value}`);
  }
  return BigInt(value);
}

export function toRpcQuantityHex(value, fieldName = "value") {
  let num;
  if (typeof value === "bigint") {
    num = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid ${fieldName}: expected non-negative safe integer`);
    }
    num = BigInt(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed) || /^(0|[1-9][0-9]*)$/.test(trimmed)) {
      num = BigInt(trimmed);
    } else {
      throw new Error(`Invalid ${fieldName}: expected non-negative integer or 0x hex`);
    }
  } else {
    throw new Error(`Invalid ${fieldName}: unsupported type`);
  }
  if (num < 0n) {
    throw new Error(`Invalid ${fieldName}: must be non-negative`);
  }
  return "0x" + num.toString(16);
}

export function formatUnits(valueBigInt, decimals = 18, maxFractionDigits = 6) {
  const val = BigInt(valueBigInt);
  const negative = val < 0n;
  const absVal = negative ? -val : val;
  const base = 10n ** BigInt(decimals);
  const whole = absVal / base;
  const rem = absVal % base;
  if (maxFractionDigits <= 0 || rem === 0n) {
    return (negative ? "-" : "") + whole.toString();
  }
  const fracFull = rem.toString().padStart(decimals, "0");
  const fracSliced = fracFull.slice(0, maxFractionDigits).replace(/0+$/, "");
  if (!fracSliced) {
    return (negative ? "-" : "") + whole.toString();
  }
  return `${negative ? "-" : ""}${whole.toString()}.${fracSliced}`;
}

export function buildChainRpcMap(overrides = {}) {
  const map = {};
  for (const chain of SUPPORTED_CHAIN_NAMES) {
    const raw = overrides?.[chain];
    let urls = [...CANONICAL_CHAINS[chain].rpcs];
    if (Array.isArray(raw) && raw.length > 0) {
      urls = raw.map((u) => String(u).trim()).filter(Boolean);
    } else if (typeof raw === "string" && raw.trim()) {
      urls = raw.split(",").map((u) => u.trim()).filter(Boolean);
    }
    const validated = urls.filter((u) => {
      try {
        const parsed = new URL(u);
        return parsed.protocol === "https:" || parsed.protocol === "http:";
      } catch {
        return false;
      }
    });
    if (validated.length === 0) {
      throw new Error(`No valid RPC URLs configured for chain '${chain}'`);
    }
    map[chain] = validated;
  }
  return map;
}

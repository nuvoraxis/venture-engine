/**
 * Canonical EVM chain configurations, AML/sanctions list, and bounded JSON-RPC client.
 * Zero external dependencies; uses standard Web fetch + AbortController.
 */

export const CANONICAL_CHAINS = {
  base: {
    chainId: 8453,
    rpc: "https://base-rpc.publicnode.com",
    rpcs: ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base", "https://mainnet.base.org"],
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    weth: "0x4200000000000000000000000000000000000006"
  },
  ethereum: {
    chainId: 1,
    rpc: "https://ethereum-rpc.publicnode.com",
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://1rpc.io/eth", "https://cloudflare-eth.com"],
    usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
  },
  arbitrum: {
    chainId: 42161,
    rpc: "https://arbitrum-one-rpc.publicnode.com",
    rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
    usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    weth: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"
  }
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Public OFAC SDN / Tornado Cash / known exploiter addresses (lowercase)
export const SANCTIONED_OR_MIXER_ADDRESSES = new Map([
  ["0x8589427373d6d84e98730d7795d8f6f8731fda16", { category: "MIXER_OFAC", label: "Tornado Cash: Router" }],
  ["0xd90e2f925da726b50c4ed8d0fb90ad053324f31b", { category: "MIXER_OFAC", label: "Tornado Cash: Router (Legacy)" }],
  ["0x722122df12d4e14e13ac3b6895a86e84145b6967", { category: "MIXER_OFAC", label: "Tornado Cash: Proxy" }],
  ["0xdd4c48c0b24039969fc16d1cdf626eab821d3384", { category: "MIXER_OFAC", label: "Tornado Cash: 0.1 ETH" }],
  ["0x910cbd523d972eb0a6f4cae4618ad62622b39dbf", { category: "MIXER_OFAC", label: "Tornado Cash: 10 ETH" }],
  ["0xa160cdab225685da1d56aa342ad8841c3b53f291", { category: "MIXER_OFAC", label: "Tornado Cash: 100 ETH" }],
  ["0x098b716b8aaf21512996dc57eb0615e2383e2f96", { category: "EXPLOIT_OFAC", label: "Lazarus Group: Ronin Exploiter" }]
]);

export function isValidEvmAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

export function normalizeAddress(addr) {
  if (!isValidEvmAddress(addr)) {
    throw new Error("Invalid EVM address format (expected 0x + 40 hex chars)");
  }
  return addr.toLowerCase();
}

export function isZeroAddress(addr) {
  return typeof addr === "string" && addr.toLowerCase() === ZERO_ADDRESS;
}

export function isValidHttpUrl(url) {
  if (typeof url !== "string" || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function resolveChainConfig(chain = "base", rpcOverrides = {}) {
  if (typeof chain !== "string" || !Object.hasOwn(CANONICAL_CHAINS, chain)) {
    throw new Error(`Unsupported chain '${chain}'. Supported: ${Object.keys(CANONICAL_CHAINS).join(", ")}`);
  }
  const baseCfg = CANONICAL_CHAINS[chain];
  const override = rpcOverrides && typeof rpcOverrides === "object" ? rpcOverrides[chain] : undefined;
  if (override !== undefined) {
    if (!isValidHttpUrl(override)) {
      throw new Error(`Invalid RPC override URL for chain '${chain}'`);
    }
    return { ...baseCfg, rpc: override, rpcs: [override] };
  }
  return baseCfg;
}

export class RpcUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = "RpcUpstreamError";
    this.statusCode = 502;
  }
}

function resolveRpcCandidates(rpcUrlOrList) {
  if (Array.isArray(rpcUrlOrList)) return rpcUrlOrList;
  for (const cfg of Object.values(CANONICAL_CHAINS)) {
    if (cfg.rpc === rpcUrlOrList && Array.isArray(cfg.rpcs)) {
      return cfg.rpcs;
    }
  }
  return [rpcUrlOrList];
}

function isGatewayTransportError(errorObj) {
  if (!errorObj || typeof errorObj !== "object") return false;
  const msg = String(errorObj.message || "");
  return errorObj.code === -32046 || errorObj.code === -32603 || /Internal error|Cannot fulfill|rate limit|too many requests/i.test(msg);
}

/**
 * Performs a bounded JSON-RPC 2.0 request with multi-RPC failover and validates the JSON response envelope.
 */
export async function rpcCall(rpcUrl, method, params, fetchImpl = fetch, timeoutMs = 8000) {
  const candidates = resolveRpcCandidates(rpcUrl);
  const safeFetch = fetchImpl === globalThis.fetch ? (u, i) => globalThis.fetch(u, i) : fetchImpl;
  let lastError = null;

  for (let i = 0; i < candidates.length; i++) {
    const target = candidates[i];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await safeFetch(target, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: controller.signal
        });
      } catch (err) {
        lastError = new RpcUpstreamError(`RPC network failure for ${method}: ${err?.message || "aborted"}`);
        continue;
      }

      if (!res.ok) {
        lastError = new RpcUpstreamError(`RPC HTTP ${res.status} for ${method}`);
        if (i < candidates.length - 1 && (res.status === 429 || res.status >= 500)) {
          continue;
        }
        throw lastError;
      }

      let data;
      try {
        data = await res.json();
      } catch {
        lastError = new RpcUpstreamError(`RPC returned invalid JSON for ${method}`);
        continue;
      }

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        lastError = new RpcUpstreamError(`RPC returned malformed envelope for ${method}`);
        continue;
      }

      if (data.error) {
        const msg = typeof data.error?.message === "string" ? data.error.message : JSON.stringify(data.error);
        if (i < candidates.length - 1 && isGatewayTransportError(data.error)) {
          lastError = new RpcUpstreamError(`RPC gateway error for ${method}: ${msg}`);
          continue;
        }
        const err = new Error(`RPC Error: ${msg}`);
        err.rpcCode = data.error?.code;
        err.isJsonRpcError = true;
        throw err;
      }

      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new RpcUpstreamError(`All RPC endpoints failed for ${method}`);
}

/**
 * Executes a read-only eth_call and treats contract execution reverts as null.
 * Transport/HTTP failures still throw RpcUpstreamError so callers know RPC is down.
 */
export async function tryEthCall(rpcUrl, to, data, fetchImpl = fetch, timeoutMs = 8000) {
  try {
    const result = await rpcCall(rpcUrl, "eth_call", [{ to, data }, "latest"], fetchImpl, timeoutMs);
    if (typeof result !== "string" || result === "0x" || !/^0x[0-9a-fA-F]+$/.test(result)) {
      return null;
    }
    return result;
  } catch (err) {
    if (err?.isJsonRpcError) {
      return null;
    }
    throw err;
  }
}

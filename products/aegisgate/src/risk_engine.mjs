/**
 * AegisGate EVM Risk, Sanctions & Contract Inspection Engine
 * Zero external dependencies; uses standard Web fetch + live EVM JSON-RPC.
 */

export const CANONICAL_CHAINS = {
  base: {
    chainId: 8453,
    rpc: "https://mainnet.base.org",
    rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  },
  ethereum: {
    chainId: 1,
    rpc: "https://ethereum-rpc.publicnode.com",
    rpcs: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.llamarpc.com",
      "https://cloudflare-eth.com"
    ],
    usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
  },
  arbitrum: {
    chainId: 42161,
    rpc: "https://arb1.arbitrum.io/rpc",
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
    usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831"
  }
};

// Public OFAC SDN / Tornado Cash / known mixer contracts (lowercase)
export const SANCTIONED_OR_MIXER_ADDRESSES = new Map([
  ["0x8589427373d6d84e98730d7795d8f6f8731fda16", { category: "MIXER_OFAC", label: "Tornado Cash: Router" }],
  ["0xd90e2f925da726b50c4ed8d0fb90ad053324f31b", { category: "MIXER_OFAC", label: "Tornado Cash: Router (Legacy)" }],
  ["0x722122df12d4e14e13ac3b6895a86e84145b6967", { category: "MIXER_OFAC", label: "Tornado Cash: Proxy" }],
  ["0xdd4c48c0b24039969fc16d1cdf626eab821d3384", { category: "MIXER_OFAC", label: "Tornado Cash: 0.1 ETH" }],
  ["0x910cbd523d972eb0a6f4cae4618ad62622b39dbf", { category: "MIXER_OFAC", label: "Tornado Cash: 10 ETH" }],
  ["0xa160cdab225685da1d56aa342ad8841c3b53f291", { category: "MIXER_OFAC", label: "Tornado Cash: 100 ETH" }],
  ["0x098b716b8aaf21512996dc57eb0615e2383e2f96", { category: "EXPLOIT_OFAC", label: "Lazarus Group: Ronin Exploiter" }]
]);

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export function isValidEvmAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

const RPC_TIMEOUT_MS = 8000;

function isDeterministicRevert(rpcError) {
  if (!rpcError || typeof rpcError !== "object") return false;
  if (rpcError.code === 3 || rpcError.code === -32015) return true;
  return typeof rpcError.message === "string" && /execution reverted/i.test(rpcError.message);
}

export async function rpcCall(rpcUrls, method, params, fetchImpl = fetch) {
  const candidates = Array.isArray(rpcUrls) && rpcUrls.length > 0 ? rpcUrls : [rpcUrls];
  let lastError = null;

  for (const rpcUrl of candidates) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(new Error(`RPC timeout after ${RPC_TIMEOUT_MS}ms`)), RPC_TIMEOUT_MS) : null;

    try {
      const res = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!res.ok) {
        const err = new Error(`RPC HTTP ${res.status}`);
        if (res.status === 429 || res.status >= 500) {
          lastError = err;
          continue;
        }
        throw err;
      }

      const data = await res.json();
      if (data?.error) {
        const err = new Error(`RPC Error: ${data.error.message || JSON.stringify(data.error)}`);
        if (!isDeterministicRevert(data.error)) {
          lastError = err;
          continue;
        }
        throw err;
      }
      if (!data || typeof data !== "object" || !Object.hasOwn(data, "result")) {
        lastError = new Error("Malformed JSON-RPC response");
        continue;
      }
      return data.result;
    } catch (err) {
      if (isDeterministicRevert({ message: err?.message })) {
        throw err;
      }
      if (err?.message && /^RPC HTTP [1-4]\d\d$/.test(err.message) && err.message !== "RPC HTTP 429") {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  throw lastError || new Error(`All RPC endpoints failed for ${method}`);
}

/**
 * Screens an EVM address across local OFAC/mixer lists and live EVM RPC state.
 */
export async function screenEvmAddress(address, chain = "base", fetchImpl = fetch) {
  if (!isValidEvmAddress(address)) {
    throw new Error("Invalid EVM address format (expected 0x + 40 hex chars)");
  }
  const chainCfg = CANONICAL_CHAINS[chain];
  if (!chainCfg) {
    throw new Error(`Unsupported chain '${chain}'. Supported: ${Object.keys(CANONICAL_CHAINS).join(", ")}`);
  }

  const normalized = address.toLowerCase();
  const flags = [];
  let riskScore = 0;

  // 1. Static OFAC / Mixer check
  const sanctioned = SANCTIONED_OR_MIXER_ADDRESSES.get(normalized);
  if (sanctioned) {
    flags.push({ code: sanctioned.category, severity: "CRITICAL", detail: sanctioned.label });
    riskScore += 100;
  }

  // 2. Live On-Chain State (parallel RPC with failover across chainCfg.rpcs)
  const rpcTargets = Array.isArray(chainCfg.rpcs) && chainCfg.rpcs.length > 0 ? chainCfg.rpcs : [chainCfg.rpc];
  const [balanceHex, nonceHex, codeHex, implSlotHex] = await Promise.all([
    rpcCall(rpcTargets, "eth_getBalance", [normalized, "latest"], fetchImpl),
    rpcCall(rpcTargets, "eth_getTransactionCount", [normalized, "latest"], fetchImpl),
    rpcCall(rpcTargets, "eth_getCode", [normalized, "latest"], fetchImpl),
    rpcCall(rpcTargets, "eth_getStorageAt", [normalized, EIP1967_IMPL_SLOT, "latest"], fetchImpl)
  ]);

  const balanceWei = BigInt(balanceHex || "0x0");
  const nonce = Number(BigInt(nonceHex || "0x0"));
  const isContract = Boolean(codeHex && codeHex !== "0x" && codeHex !== "0x0");
  const bytecodeBytes = isContract ? (codeHex.length - 2) / 2 : 0;

  let isEip1967Proxy = false;
  let implementationAddress = null;
  if (isContract && implSlotHex && implSlotHex !== "0x" && !/^0x0+$/.test(implSlotHex)) {
    isEip1967Proxy = true;
    implementationAddress = "0x" + implSlotHex.slice(-40);
    flags.push({
      code: "UPGRADEABLE_EIP1967_PROXY",
      severity: "MEDIUM",
      detail: `Upgradeable proxy pointing to ${implementationAddress}`
    });
    riskScore += 25;
  }

  if (!isContract && nonce === 0 && balanceWei === 0n) {
    flags.push({
      code: "FRESH_ZERO_HISTORY_EOA",
      severity: "LOW",
      detail: "Address has 0 transactions and 0 native balance on this chain"
    });
    riskScore += 10;
  }

  const clampedScore = Math.min(100, riskScore);
  const verdict = clampedScore >= 80 ? "BLOCK" : clampedScore >= 40 ? "REVIEW" : "ALLOW";

  return {
    address: normalized,
    chain,
    chainId: chainCfg.chainId,
    verdict,
    riskScore: clampedScore,
    isContract,
    bytecodeBytes,
    isEip1967Proxy,
    implementationAddress,
    nonce,
    nativeBalanceWei: balanceWei.toString(),
    flags,
    checkedAt: new Date().toISOString()
  };
}

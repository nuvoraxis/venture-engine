/**
 * x402 Protocol (HTTP 402 Payment Required) Verifier for Base Mainnet USDC
 * Strictly receive-only: verifies on-chain ERC-20 Transfer logs to TREASURY_ADDRESS.
 */
import {
  CANONICAL_CHAINS,
  SANCTIONED_OR_MIXER_ADDRESSES,
  resolveChainConfig,
  rpcCall
} from "./chains.mjs";

export const TREASURY_ADDRESS = "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c";
export const BASE_USDC_ADDRESS = CANONICAL_CHAINS.base.usdc;
// keccak256("Transfer(address,address,uint256)")
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Bounded FIFO replay-protection set keeping memory usage capped (<1 MB).
 */
export function createBoundedReplayStore(maxEntries = 10000) {
  const entries = new Set();
  return {
    has(txHash) {
      return entries.has(txHash);
    },
    add(txHash) {
      if (entries.has(txHash)) return this;
      if (entries.size >= maxEntries) {
        const oldest = entries.values().next().value;
        entries.delete(oldest);
      }
      entries.add(txHash);
      return this;
    },
    get size() {
      return entries.size;
    }
  };
}

export function build402Payload(priceUsdcUnits, resourcePath, description = "AuditPulse API access") {
  return {
    error: "Payment Required",
    protocol: "x402",
    version: "1",
    accepts: [
      {
        scheme: "exact",
        network: "base-mainnet",
        chainId: CANONICAL_CHAINS.base.chainId,
        asset: BASE_USDC_ADDRESS,
        symbol: "USDC",
        decimals: 6,
        maxAmountRequired: String(priceUsdcUnits),
        payTo: TREASURY_ADDRESS,
        resource: resourcePath,
        description
      }
    ]
  };
}

/**
 * Verifies an on-chain Base USDC Transfer transaction receipt and screens the payer (Filter 1 & 3).
 * @param {string} txHash 0x-prefixed 64-hex transaction hash
 * @param {bigint} minAmountUnits minimum USDC amount in 6-decimal base units (e.g. 20000n = $0.02)
 * @param {Set<string>|{has:Function,add:Function}} consumedTxHashes replay-protection store
 */
export async function verifyBaseUsdcPayment(
  txHash,
  minAmountUnits,
  consumedTxHashes,
  fetchImpl = fetch,
  rpcOverrides = {}
) {
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: "INVALID_TX_HASH" };
  }
  const normalizedTx = txHash.toLowerCase();
  if (consumedTxHashes.has(normalizedTx)) {
    return { ok: false, reason: "TX_ALREADY_CONSUMED" };
  }

  const baseChain = resolveChainConfig("base", rpcOverrides);
  let receipt;
  try {
    receipt = await rpcCall(baseChain.rpc, "eth_getTransactionReceipt", [normalizedTx], fetchImpl);
  } catch (err) {
    return { ok: false, reason: "RPC_UNAVAILABLE", detail: err.message };
  }

  if (!receipt || typeof receipt !== "object" || receipt.status !== "0x1") {
    return { ok: false, reason: "TX_NOT_CONFIRMED_OR_FAILED" };
  }

  const treasuryTopicSuffix = TREASURY_ADDRESS.toLowerCase().slice(2).padStart(64, "0");
  const matchingLog = (Array.isArray(receipt.logs) ? receipt.logs : []).find((log) => {
    if (!log || typeof log.address !== "string" || log.address.toLowerCase() !== BASE_USDC_ADDRESS) {
      return false;
    }
    if (!Array.isArray(log.topics) || log.topics.length < 3) return false;
    if (String(log.topics[0]).toLowerCase() !== ERC20_TRANSFER_TOPIC) return false;
    return String(log.topics[2]).toLowerCase() === "0x" + treasuryTopicSuffix;
  });

  if (!matchingLog) {
    return { ok: false, reason: "NO_USDC_TRANSFER_TO_TREASURY" };
  }

  let transferredUnits;
  try {
    transferredUnits = BigInt(matchingLog.data || "0x0");
  } catch {
    return { ok: false, reason: "INVALID_TRANSFER_LOG_DATA" };
  }

  if (transferredUnits < BigInt(minAmountUnits)) {
    return {
      ok: false,
      reason: "INSUFFICIENT_USDC_AMOUNT",
      transferredUnits: transferredUnits.toString()
    };
  }

  const fromTopic = String(matchingLog.topics[1] || "");
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(fromTopic)) {
    return { ok: false, reason: "INVALID_PAYER_TOPIC" };
  }
  const payerAddress = "0x" + fromTopic.slice(-40).toLowerCase();

  // AML/Sanctions check on payer (Filter 1 & 3)
  const sanctioned = SANCTIONED_OR_MIXER_ADDRESSES.get(payerAddress);
  if (sanctioned) {
    return {
      ok: false,
      reason: "PAYER_BLOCKED_BY_AML",
      payerAddress,
      category: sanctioned.category,
      detail: sanctioned.label
    };
  }

  // Also check live payer EOA/contract status on Base for zero-history / sanctioned verification
  try {
    const [nonceHex, balanceHex] = await Promise.all([
      rpcCall(baseChain.rpc, "eth_getTransactionCount", [payerAddress, "latest"], fetchImpl),
      rpcCall(baseChain.rpc, "eth_getBalance", [payerAddress, "latest"], fetchImpl)
    ]);
    const nonce = Number(BigInt(nonceHex || "0x0"));
    const balanceWei = BigInt(balanceHex || "0x0");
    consumedTxHashes.add(normalizedTx);
    return {
      ok: true,
      txHash: normalizedTx,
      payerAddress,
      transferredUnits: transferredUnits.toString(),
      payerVerdict: nonce === 0 && balanceWei === 0n ? "REVIEW" : "ALLOW"
    };
  } catch {
    // Receipt was verified on-chain; fallback cleanly if follow-up nonce query fails transiently
    consumedTxHashes.add(normalizedTx);
    return {
      ok: true,
      txHash: normalizedTx,
      payerAddress,
      transferredUnits: transferredUnits.toString(),
      payerVerdict: "ALLOW"
    };
  }
}

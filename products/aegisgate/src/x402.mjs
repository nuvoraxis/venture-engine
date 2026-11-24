/**
 * x402 Protocol (HTTP 402 Payment Required) Verifier for Base Mainnet USDC
 * Strictly receive-only: verifies on-chain ERC-20 Transfer logs to TREASURY_ADDRESS.
 */
import { CANONICAL_CHAINS, screenEvmAddress } from "./risk_engine.mjs";

export const TREASURY_ADDRESS = "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c";
export const BASE_USDC_ADDRESS = CANONICAL_CHAINS.base.usdc;
// keccak256("Transfer(address,address,uint256)")
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function build402Payload(priceUsdcUnits, resourcePath) {
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
        resource: resourcePath
      }
    ]
  };
}

/**
 * Verifies an on-chain Base USDC Transfer transaction receipt and screens the payer (Filter 1 & 3).
 * @param {string} txHash 0x-prefixed 64-hex transaction hash
 * @param {bigint} minAmountUnits minimum USDC amount in 6-decimal base units (e.g. 10000n = $0.01)
 * @param {Set<string>} consumedTxHashes replay-protection store
 */
export async function verifyBaseUsdcPayment(txHash, minAmountUnits, consumedTxHashes, fetchImpl = fetch) {
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: "INVALID_TX_HASH" };
  }
  const normalizedTx = txHash.toLowerCase();
  if (consumedTxHashes.has(normalizedTx)) {
    return { ok: false, reason: "TX_ALREADY_CONSUMED" };
  }

  const baseRpcs =
    Array.isArray(CANONICAL_CHAINS.base.rpcs) && CANONICAL_CHAINS.base.rpcs.length > 0
      ? CANONICAL_CHAINS.base.rpcs
      : [CANONICAL_CHAINS.base.rpc];

  let receipt = null;
  let lastHttpReason = null;
  let sawSuccessfulRpc = false;

  for (const rpcUrl of baseRpcs) {
    try {
      const res = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [normalizedTx]
        })
      });
      if (!res.ok) {
        lastHttpReason = `RPC_HTTP_${res.status}`;
        if (res.status === 429 || res.status >= 500) continue;
        return { ok: false, reason: lastHttpReason };
      }
      const payload = await res.json();
      if (payload?.error) {
        lastHttpReason = "RPC_ERROR";
        continue;
      }
      receipt = payload?.result || null;
      sawSuccessfulRpc = true;
      break;
    } catch {
      lastHttpReason = "RPC_UNAVAILABLE";
    }
  }

  if (!sawSuccessfulRpc) {
    return { ok: false, reason: lastHttpReason || "RPC_UNAVAILABLE" };
  }
  if (!receipt || receipt.status !== "0x1") {
    return { ok: false, reason: "TX_NOT_CONFIRMED_OR_FAILED" };
  }

  const treasuryTopicSuffix = TREASURY_ADDRESS.toLowerCase().slice(2).padStart(64, "0");
  const matchingLog = (receipt.logs || []).find((log) => {
    if (!log.address || log.address.toLowerCase() !== BASE_USDC_ADDRESS) return false;
    if (!log.topics || log.topics.length < 3) return false;
    if (log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) return false;
    return log.topics[2].toLowerCase() === "0x" + treasuryTopicSuffix;
  });

  if (!matchingLog) {
    return { ok: false, reason: "NO_USDC_TRANSFER_TO_TREASURY" };
  }

  const transferredUnits = BigInt(matchingLog.data || "0x0");
  if (transferredUnits < BigInt(minAmountUnits)) {
    return { ok: false, reason: "INSUFFICIENT_USDC_AMOUNT", transferredUnits: transferredUnits.toString() };
  }

  const payerAddress = "0x" + matchingLog.topics[1].slice(-40).toLowerCase();
  const payerScreen = await screenEvmAddress(payerAddress, "base", fetchImpl);
  if (payerScreen.verdict === "BLOCK") {
    return { ok: false, reason: "PAYER_BLOCKED_BY_AML", payerAddress, payerScreen };
  }

  consumedTxHashes.add(normalizedTx);
  return {
    ok: true,
    txHash: normalizedTx,
    payerAddress,
    transferredUnits: transferredUnits.toString(),
    payerVerdict: payerScreen.verdict
  };
}

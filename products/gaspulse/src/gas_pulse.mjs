/**
 * GasPulse & Mempool Guard Core Engine:
 *   1. EIP-1559 Multi-Chain Gas Estimator & Congestion Telemetry
 *   2. Pre-Flight eth_call / eth_estimateGas Simulation + Revert Decoder
 *   3. Mempool Safety & AML/OFAC Pre-Flight Guard
 */
import {
  CANONICAL_CHAINS,
  checkAddressSanctions,
  formatUnits,
  isValidEvmAddress,
  isValidHexBytes,
  normalizeChain,
  parseHexBigInt,
  toRpcQuantityHex
} from "./chains.mjs";

const PANIC_CODES = new Map([
  ["0x00", "Generic compiler panic"],
  ["0x01", "Assertion failed"],
  ["0x11", "Arithmetic overflow or underflow"],
  ["0x12", "Division or modulo by zero"],
  ["0x21", "Invalid enum conversion"],
  ["0x22", "Invalid storage byte array access"],
  ["0x31", "Pop on empty array"],
  ["0x32", "Array index out of bounds"],
  ["0x41", "Out of memory allocation"],
  ["0x51", "Called zero-initialized internal function"]
]);

// Known DEX / AMM swap function selectors (advisory public-mempool sandwich exposure signal)
const SWAP_SELECTORS = new Set([
  "0x38ed1739", // swapExactTokensForTokens
  "0x7ff36ab5", // swapExactETHForTokens
  "0x18cbafe5", // swapExactTokensForETH
  "0x414bf389", // Uniswap V3 exactInputSingle (legacy)
  "0x04e45aaf", // Uniswap V3 SwapRouter02 exactInputSingle
  "0xc04b8d59", // Uniswap V3 exactInput
  "0xb858183f", // Uniswap V3 exactInput (SwapRouter02)
  "0x3593564c"  // Universal Router execute
]);

const STANDARD_TRANSFER_GAS = 21000n;
const TYPICAL_SWAP_GAS = 150000n;
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

function hexToBytes(hexNoPrefix) {
  const bytes = new Uint8Array(hexNoPrefix.length / 2);
  for (let i = 0; i < hexNoPrefix.length; i += 2) {
    bytes[i / 2] = parseInt(hexNoPrefix.slice(i, i + 2), 16);
  }
  return bytes;
}

function extractRevertHex(rpcError) {
  if (!rpcError || typeof rpcError !== "object") return null;
  if (typeof rpcError.data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(rpcError.data)) {
    return rpcError.data;
  }
  if (rpcError.data && typeof rpcError.data === "object") {
    for (const candidate of [rpcError.data.data, rpcError.data.result]) {
      if (typeof candidate === "string" && /^0x[0-9a-fA-F]{8,}$/.test(candidate)) {
        return candidate;
      }
    }
  }
  if (typeof rpcError.message === "string") {
    const match = rpcError.message.match(/0x[0-9a-fA-F]{8,}/);
    if (match) return match[0];
  }
  return null;
}

/**
 * Decodes ABI-encoded Solidity Error(string), Panic(uint256), or RPC text revert messages.
 */
export function decodeRevertData(rpcError) {
  const hex = extractRevertHex(rpcError);
  if (hex) {
    const lower = hex.toLowerCase();
    // Error(string) = 0x08c379a0 + 32b offset + 32b len + utf8 bytes
    if (lower.startsWith("0x08c379a0") && lower.length >= 138) {
      try {
        const offsetBytes = Number(BigInt("0x" + lower.slice(10, 74)));
        const lenStart = 10 + offsetBytes * 2;
        if (lenStart + 64 <= lower.length) {
          const strLen = Number(BigInt("0x" + lower.slice(lenStart, lenStart + 64)));
          const strHexStart = lenStart + 64;
          const strHexEnd = strHexStart + strLen * 2;
          if (strLen >= 0 && strLen <= 4096 && strHexEnd <= lower.length) {
            return utf8Decoder.decode(hexToBytes(lower.slice(strHexStart, strHexEnd)));
          }
        }
      } catch {
        // Fall through to message/selector fallback
      }
    }

    // Panic(uint256) = 0x4e487b71 + 32b code
    if (lower.startsWith("0x4e487b71") && lower.length >= 74) {
      const codeHex = "0x" + lower.slice(72, 74);
      const label = PANIC_CODES.get(codeHex);
      return label ? `Panic(${codeHex}): ${label}` : `Panic(${codeHex})`;
    }

    if (typeof rpcError?.message === "string" && !/^execution reverted$/i.test(rpcError.message.trim())) {
      return `${rpcError.message} (selector ${lower.slice(0, 10)})`;
    }
    return `Custom error selector ${lower.slice(0, 10)}`;
  }

  if (typeof rpcError?.message === "string" && rpcError.message.trim()) {
    return rpcError.message.replace(/^execution reverted:\s*/i, "").trim();
  }
  return "Execution reverted";
}

function medianBigInt(values) {
  if (!values || values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2n;
}

function buildFeeTier(name, nextBaseFeeWei, priorityFeeWei, baseMultiplierNumerator, confirmSeconds) {
  const bufferedBase = (nextBaseFeeWei * BigInt(baseMultiplierNumerator)) / 100n;
  const maxFeeWei = bufferedBase + priorityFeeWei;
  return {
    tier: name,
    maxPriorityFeePerGasWei: priorityFeeWei.toString(),
    maxPriorityFeePerGasGwei: formatUnits(priorityFeeWei, 9, 4),
    maxFeePerGasWei: maxFeeWei.toString(),
    maxFeePerGasGwei: formatUnits(maxFeeWei, 9, 4),
    estimatedConfirmationSeconds: confirmSeconds,
    estimatedTransferCostEth: formatUnits(maxFeeWei * STANDARD_TRANSFER_GAS, 18, 6),
    estimatedSwapCostEth: formatUnits(maxFeeWei * TYPICAL_SWAP_GAS, 18, 6)
  };
}

/**
 * Computes EIP-1559 fee tiers, base fee trend, and congestion telemetry via multi-RPC failover.
 */
export async function estimateGasMetrics(chain = "base", rpcPool) {
  const normalizedChain = normalizeChain(chain);
  const chainCfg = CANONICAL_CHAINS[normalizedChain];

  const [feeHistoryRes, priorityRes, gasPriceRes] = await Promise.allSettled([
    rpcPool.callWithMeta(normalizedChain, "eth_feeHistory", ["0x14", "latest", [10, 25, 50, 75, 90]]),
    rpcPool.callWithMeta(normalizedChain, "eth_maxPriorityFeePerGas", []),
    rpcPool.callWithMeta(normalizedChain, "eth_gasPrice", [])
  ]);

  let rpcEndpoint = null;
  let rpcLatencyMs = null;
  let failoverAttempts = 1;

  const pickMeta = (settled) => {
    if (settled.status === "fulfilled" && settled.value.ok) {
      if (rpcEndpoint === null) {
        rpcEndpoint = settled.value.endpoint;
        rpcLatencyMs = settled.value.latencyMs;
        failoverAttempts = settled.value.attempts.length;
      }
      return settled.value.result;
    }
    return null;
  };

  const feeHistory = pickMeta(feeHistoryRes);
  const suggestedPriorityHex = pickMeta(priorityRes);
  const gasPriceHex = pickMeta(gasPriceRes);

  if (!feeHistory && !gasPriceHex && !suggestedPriorityHex) {
    const firstErr =
      feeHistoryRes.status === "rejected"
        ? feeHistoryRes.reason
        : gasPriceRes.status === "rejected"
          ? gasPriceRes.reason
          : new Error("Failed to fetch chain gas metrics");
    throw firstErr;
  }

  let baseFeeWei = 0n;
  let nextBaseFeeWei = 0n;
  let oldestBlockNumber = null;
  let avgGasUsedRatio = 0;
  let baseFeeTrend = "stable";

  const p10List = [];
  const p25List = [];
  const p50List = [];
  const p75List = [];
  const p90List = [];

  if (feeHistory && Array.isArray(feeHistory.baseFeePerGas) && feeHistory.baseFeePerGas.length > 0) {
    const baseFees = feeHistory.baseFeePerGas.map((h) => parseHexBigInt(h, 0n));
    nextBaseFeeWei = baseFees[baseFees.length - 1];
    baseFeeWei = baseFees.length >= 2 ? baseFees[baseFees.length - 2] : nextBaseFeeWei;

    if (baseFees.length >= 4) {
      const early = baseFees[0];
      const latest = baseFees[baseFees.length - 2];
      if (early > 0n) {
        const deltaBps = Number(((latest - early) * 10000n) / early);
        if (deltaBps > 500) baseFeeTrend = "rising";
        else if (deltaBps < -500) baseFeeTrend = "falling";
      }
    }

    if (feeHistory.oldestBlock) {
      oldestBlockNumber = Number(parseHexBigInt(feeHistory.oldestBlock, 0n));
    }
    if (Array.isArray(feeHistory.gasUsedRatio) && feeHistory.gasUsedRatio.length > 0) {
      const ratios = feeHistory.gasUsedRatio.map((r) => Number(r)).filter((n) => Number.isFinite(n));
      if (ratios.length > 0) {
        avgGasUsedRatio = Number((ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(4));
      }
    }
    if (Array.isArray(feeHistory.reward)) {
      for (const blockRewards of feeHistory.reward) {
        if (!Array.isArray(blockRewards) || blockRewards.length < 5) continue;
        p10List.push(parseHexBigInt(blockRewards[0], 0n));
        p25List.push(parseHexBigInt(blockRewards[1], 0n));
        p50List.push(parseHexBigInt(blockRewards[2], 0n));
        p75List.push(parseHexBigInt(blockRewards[3], 0n));
        p90List.push(parseHexBigInt(blockRewards[4], 0n));
      }
    }
  }

  const fallbackPriorityWei = suggestedPriorityHex ? parseHexBigInt(suggestedPriorityHex, 1_000_000n) : 1_000_000n;
  const legacyGasPriceWei = gasPriceHex ? parseHexBigInt(gasPriceHex, 0n) : 0n;

  if (nextBaseFeeWei === 0n && legacyGasPriceWei > 0n) {
    baseFeeWei = legacyGasPriceWei > fallbackPriorityWei ? legacyGasPriceWei - fallbackPriorityWei : legacyGasPriceWei;
    nextBaseFeeWei = baseFeeWei;
  }

  const p10Priority = p10List.length ? medianBigInt(p10List) : fallbackPriorityWei / 2n || 1n;
  const p25Priority = p25List.length ? medianBigInt(p25List) : fallbackPriorityWei;
  const p50Priority = p50List.length ? medianBigInt(p50List) : fallbackPriorityWei;
  const p75Priority = p75List.length ? medianBigInt(p75List) : (fallbackPriorityWei * 15n) / 10n;
  const p90Priority = p90List.length ? medianBigInt(p90List) : fallbackPriorityWei * 2n;

  const stdPriority = p50Priority > p25Priority ? p50Priority : p25Priority;

  let congestionLevel = "LOW";
  if (avgGasUsedRatio >= 0.9 || baseFeeTrend === "rising" && avgGasUsedRatio >= 0.75) {
    congestionLevel = "EXTREME";
  } else if (avgGasUsedRatio >= 0.72) {
    congestionLevel = "HIGH";
  } else if (avgGasUsedRatio >= 0.45) {
    congestionLevel = "MODERATE";
  }

  const bt = chainCfg.blockTimeSeconds;
  const tiers = {
    slow: buildFeeTier("slow", nextBaseFeeWei, p10Priority, 105, Math.max(1, Math.round(bt * 4))),
    standard: buildFeeTier("standard", nextBaseFeeWei, stdPriority, 115, Math.max(1, Math.round(bt * 2))),
    fast: buildFeeTier("fast", nextBaseFeeWei, p75Priority, 125, Math.max(1, Math.round(bt))),
    urgent: buildFeeTier("urgent", nextBaseFeeWei, p90Priority, 150, Math.max(1, Math.round(bt)))
  };

  return {
    chain: normalizedChain,
    chainId: chainCfg.chainId,
    nativeSymbol: chainCfg.nativeSymbol,
    blockTimeSeconds: bt,
    oldestSampledBlock: oldestBlockNumber,
    baseFeePerGasWei: baseFeeWei.toString(),
    baseFeePerGasGwei: formatUnits(baseFeeWei, 9, 4),
    nextBaseFeePerGasWei: nextBaseFeeWei.toString(),
    nextBaseFeePerGasGwei: formatUnits(nextBaseFeeWei, 9, 4),
    legacyGasPriceWei: legacyGasPriceWei.toString(),
    legacyGasPriceGwei: formatUnits(legacyGasPriceWei, 9, 4),
    baseFeeTrend,
    avgGasUsedRatio,
    congestionLevel,
    tiers,
    rpc: {
      endpoint: rpcEndpoint,
      latencyMs: rpcLatencyMs,
      failoverAttempts
    },
    measuredAt: new Date().toISOString()
  };
}

function validateSimulationPayload(rawInput) {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    throw new Error("Simulation payload must be a JSON object");
  }

  const chain = normalizeChain(rawInput.chain || "base");
  const txSource = rawInput.tx && typeof rawInput.tx === "object" && !Array.isArray(rawInput.tx) ? rawInput.tx : rawInput;

  const blockTag = rawInput.blockTag === undefined ? "latest" : String(rawInput.blockTag).trim();
  if (blockTag !== "latest" && blockTag !== "pending" && !/^0x[0-9a-fA-F]+$/.test(blockTag)) {
    throw new Error("Invalid blockTag: expected 'latest', 'pending', or 0x block number");
  }

  const from = txSource.from !== undefined && txSource.from !== null && txSource.from !== "" ? String(txSource.from).trim() : null;
  if (from && !isValidEvmAddress(from)) {
    throw new Error("Invalid 'from' address format (expected 0x + 40 hex chars)");
  }

  const to = txSource.to !== undefined && txSource.to !== null && txSource.to !== "" ? String(txSource.to).trim() : null;
  if (to && !isValidEvmAddress(to)) {
    throw new Error("Invalid 'to' address format (expected 0x + 40 hex chars)");
  }

  const data = txSource.data !== undefined && txSource.data !== null && txSource.data !== "" ? String(txSource.data).trim() : "0x";
  if (!isValidHexBytes(data)) {
    throw new Error("Invalid 'data' calldata (expected 0x-prefixed even-length hex)");
  }

  if (!to && data.length <= 2) {
    throw new Error("Transaction requires a 'to' address or non-empty deployment 'data'");
  }

  const valueHex =
    txSource.value !== undefined && txSource.value !== null && txSource.value !== ""
      ? toRpcQuantityHex(txSource.value, "value")
      : "0x0";
  const gasHex =
    txSource.gas !== undefined && txSource.gas !== null && txSource.gas !== ""
      ? toRpcQuantityHex(txSource.gas, "gas")
      : null;

  const userMaxFeeWei =
    txSource.maxFeePerGas !== undefined && txSource.maxFeePerGas !== null && txSource.maxFeePerGas !== ""
      ? parseHexBigInt(toRpcQuantityHex(txSource.maxFeePerGas, "maxFeePerGas"), 0n)
      : null;
  const userPriorityFeeWei =
    txSource.maxPriorityFeePerGas !== undefined &&
    txSource.maxPriorityFeePerGas !== null &&
    txSource.maxPriorityFeePerGas !== ""
      ? parseHexBigInt(toRpcQuantityHex(txSource.maxPriorityFeePerGas, "maxPriorityFeePerGas"), 0n)
      : null;

  const callObj = {};
  if (from) callObj.from = from.toLowerCase();
  if (to) callObj.to = to.toLowerCase();
  if (data !== "0x") callObj.data = data.toLowerCase();
  if (valueHex !== "0x0") callObj.value = valueHex;
  if (gasHex && gasHex !== "0x0") callObj.gas = gasHex;

  return {
    chain,
    blockTag,
    from: from ? from.toLowerCase() : null,
    to: to ? to.toLowerCase() : null,
    data: data.toLowerCase(),
    valueWei: parseHexBigInt(valueHex, 0n),
    gasLimitSupplied: gasHex ? parseHexBigInt(gasHex, 0n) : null,
    userMaxFeeWei,
    userPriorityFeeWei,
    callObj
  };
}

/**
 * Executes pre-flight eth_call + eth_estimateGas simulation, OFAC/mixer check,
 * balance check, and mempool sandwich/fee guard analysis.
 */
export async function simulateTransaction(rawInput, rpcPool) {
  const parsed = validateSimulationPayload(rawInput);

  // Filter 1 & 3 Fail-Closed OFAC/Mixer Pre-Check on from/to
  const sanctionedMatches = [parsed.from, parsed.to]
    .filter(Boolean)
    .map((addr) => checkAddressSanctions(addr))
    .filter(Boolean);

  if (sanctionedMatches.length > 0) {
    return {
      blocked: true,
      chain: parsed.chain,
      chainId: CANONICAL_CHAINS[parsed.chain].chainId,
      verdict: "BLOCK",
      reason: "OFAC_MIXER_ADDRESS_BLOCKED",
      sanctionedMatches,
      checkedAt: new Date().toISOString()
    };
  }

  const tasks = [
    rpcPool.callWithMeta(parsed.chain, "eth_call", [parsed.callObj, parsed.blockTag]),
    rpcPool.callWithMeta(parsed.chain, "eth_estimateGas", [parsed.callObj, parsed.blockTag]),
    estimateGasMetrics(parsed.chain, rpcPool),
    parsed.from ? rpcPool.callWithMeta(parsed.chain, "eth_getBalance", [parsed.from, "latest"]) : Promise.resolve(null)
  ];

  const [callSettled, estimateSettled, gasMetricsSettled, balanceSettled] = await Promise.allSettled(tasks);

  if (callSettled.status === "rejected") throw callSettled.reason;
  if (gasMetricsSettled.status === "rejected") throw gasMetricsSettled.reason;

  const callRes = callSettled.value;
  const gasMetrics = gasMetricsSettled.value;

  let estimateRes;
  if (estimateSettled.status === "fulfilled") {
    estimateRes = estimateSettled.value;
  } else if (!callRes.ok && callRes.reverted) {
    // eth_call already proved deterministic revert; tolerate node estimateGas quirks
    estimateRes = { ok: false, reverted: true, rpcError: callRes.rpcError };
  } else {
    throw estimateSettled.reason;
  }

  const balanceRes = balanceSettled.status === "fulfilled" ? balanceSettled.value : null;

  const willRevert = !callRes.ok || !estimateRes.ok;
  const revertErrorObj = !callRes.ok ? callRes.rpcError : !estimateRes.ok ? estimateRes.rpcError : null;
  const revertReason = willRevert ? decodeRevertData(revertErrorObj) : null;

  const estimatedGasWei = estimateRes.ok ? parseHexBigInt(estimateRes.result, 0n) : 0n;
  const recommendedGasLimit = estimatedGasWei > 0n ? (estimatedGasWei * 120n + 99n) / 100n : 0n;

  const standardMaxFeeWei = BigInt(gasMetrics.tiers.standard.maxFeePerGasWei);
  const urgentPriorityWei = BigInt(gasMetrics.tiers.urgent.maxPriorityFeePerGasWei);
  const nextBaseFeeWei = BigInt(gasMetrics.nextBaseFeePerGasWei);
  const effectiveMaxFeeWei = parsed.userMaxFeeWei ?? standardMaxFeeWei;

  const estimatedFeeWei = estimatedGasWei * effectiveMaxFeeWei;
  const worstCaseFeeWei = recommendedGasLimit * effectiveMaxFeeWei;
  const senderBalanceWei = balanceRes && balanceRes.ok ? parseHexBigInt(balanceRes.result, 0n) : null;

  const warnings = [];
  if (parsed.gasLimitSupplied !== null && estimatedGasWei > 0n && parsed.gasLimitSupplied < estimatedGasWei) {
    warnings.push({
      code: "SUPPLIED_GAS_BELOW_ESTIMATE",
      severity: "HIGH",
      detail: `Supplied gas ${parsed.gasLimitSupplied} is below estimated ${estimatedGasWei}`
    });
  }
  if (parsed.userMaxFeeWei !== null && parsed.userMaxFeeWei < nextBaseFeeWei) {
    warnings.push({
      code: "MAX_FEE_BELOW_NEXT_BASE_FEE",
      severity: "HIGH",
      detail: `Supplied maxFeePerGas (${parsed.userMaxFeeWei} wei) is below next base fee (${nextBaseFeeWei} wei); transaction risks stalling in mempool`
    });
  }
  if (
    parsed.userPriorityFeeWei !== null &&
    parsed.userPriorityFeeWei > urgentPriorityWei * 3n &&
    parsed.userPriorityFeeWei > 5_000_000_000n
  ) {
    warnings.push({
      code: "EXCESSIVE_PRIORITY_FEE_OVERPAY",
      severity: "MEDIUM",
      detail: "Supplied priority fee exceeds 3x urgent 90th-percentile tip"
    });
  }
  if (senderBalanceWei !== null && !willRevert) {
    const requiredWei = parsed.valueWei + worstCaseFeeWei;
    if (senderBalanceWei < requiredWei) {
      warnings.push({
        code: "INSUFFICIENT_NATIVE_BALANCE_FOR_VALUE_AND_GAS",
        severity: "HIGH",
        detail: `Sender balance ${senderBalanceWei} wei is below value + buffered max fee (${requiredWei} wei)`
      });
    }
  }

  const selector = parsed.data.length >= 10 ? parsed.data.slice(0, 10) : null;
  if (selector && SWAP_SELECTORS.has(selector) && parsed.chain === "ethereum") {
    warnings.push({
      code: "MEMPOOL_SANDWICH_EXPOSURE",
      severity: "MEDIUM",
      detail: "Public-mempool DEX swap detected on Ethereum mainnet; use tight slippage bounds or private orderflow RPC"
    });
  }

  let verdict = "PASS";
  if (willRevert) verdict = "REVERT";
  else if (warnings.length > 0) verdict = "WARN";

  const riskLevel = willRevert
    ? "CRITICAL"
    : warnings.some((w) => w.severity === "HIGH")
      ? "HIGH"
      : warnings.length > 0
        ? "MEDIUM"
        : "LOW";

  return {
    blocked: false,
    chain: parsed.chain,
    chainId: CANONICAL_CHAINS[parsed.chain].chainId,
    blockTag: parsed.blockTag,
    verdict,
    willRevert,
    revertReason,
    returnData: callRes.ok ? callRes.result : null,
    estimatedGas: estimatedGasWei.toString(),
    recommendedGasLimit: recommendedGasLimit.toString(),
    estimatedFeeWei: estimatedFeeWei.toString(),
    estimatedFeeEth: formatUnits(estimatedFeeWei, 18, 6),
    worstCaseFeeWei: worstCaseFeeWei.toString(),
    worstCaseFeeEth: formatUnits(worstCaseFeeWei, 18, 6),
    senderBalanceWei: senderBalanceWei !== null ? senderBalanceWei.toString() : null,
    gasTiers: gasMetrics.tiers,
    congestionLevel: gasMetrics.congestionLevel,
    mempoolGuard: {
      riskLevel,
      swapSelectorDetected: Boolean(selector && SWAP_SELECTORS.has(selector)),
      warnings
    },
    rpc: {
      endpoint: callRes.endpoint,
      latencyMs: callRes.latencyMs,
      failoverAttempts: callRes.attempts.length
    },
    simulatedAt: new Date().toISOString()
  };
}

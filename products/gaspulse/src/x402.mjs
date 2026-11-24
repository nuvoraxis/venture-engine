/**
 * x402 Protocol (HTTP 402 Payment Required) Verifier for Base Mainnet USDC + B2B API Key Auth
 * Strictly receive-only: verifies on-chain Base USDC Transfer logs to TREASURY_ADDRESS.
 */
import {
  CANONICAL_CHAINS,
  TREASURY_ADDRESS,
  checkAddressSanctions,
  isValidTxHash
} from "./chains.mjs";

export { TREASURY_ADDRESS };
export const BASE_USDC_ADDRESS = CANONICAL_CHAINS.base.usdc;
// keccak256("Transfer(address,address,uint256)")
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const DEFAULT_PRICE_USDC_UNITS = 10000n; // $0.01 USDC (6 decimals)

/**
 * Memory-bounded FIFO replay cache (<2 MB RAM even at full capacity).
 */
export function createReplayStore(maxEntries = 10000) {
  const store = new Set();
  return {
    has(txHash) {
      return store.has(txHash);
    },
    add(txHash) {
      if (store.has(txHash)) return this;
      if (store.size >= maxEntries) {
        const oldest = store.values().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.add(txHash);
      return this;
    },
    delete(txHash) {
      return store.delete(txHash);
    },
    get size() {
      return store.size;
    }
  };
}

export function build402Payload(priceUsdcUnits = DEFAULT_PRICE_USDC_UNITS, resourcePath = "/") {
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

async function fetchReceipt(normalizedTx, fetchOrOptions) {
  try {
    if (fetchOrOptions && typeof fetchOrOptions === "object" && fetchOrOptions.rpcPool) {
      const res = await fetchOrOptions.rpcPool.callWithMeta("base", "eth_getTransactionReceipt", [normalizedTx]);
      return { ok: true, receipt: res.result };
    }

    const fetchImpl = typeof fetchOrOptions === "function" ? fetchOrOptions : fetchOrOptions?.fetchImpl || fetch;
    let lastFailure = "RPC_UNAVAILABLE";

    for (const rpcUrl of CANONICAL_CHAINS.base.rpcs) {
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
          lastFailure = `RPC_HTTP_${res.status}`;
          continue;
        }
        const payload = await res.json();
        if (payload?.error) {
          lastFailure = "RPC_ERROR";
          continue;
        }
        return { ok: true, receipt: payload?.result || null };
      } catch {
        lastFailure = "RPC_UNAVAILABLE";
      }
    }
    return { ok: false, reason: lastFailure };
  } catch {
    return { ok: false, reason: "RPC_UNAVAILABLE" };
  }
}

/**
 * Verifies an on-chain Base USDC Transfer transaction receipt and enforces AML/sanctions screening.
 * Accepts either `fetchImpl` function or `{ fetchImpl, rpcPool, inFlightTxHashes }` as 4th argument.
 */
export async function verifyBaseUsdcPayment(
  txHash,
  minAmountUnits = DEFAULT_PRICE_USDC_UNITS,
  consumedTxHashes,
  fetchOrOptions = fetch
) {
  if (!isValidTxHash(txHash)) {
    return { ok: false, reason: "INVALID_TX_HASH" };
  }
  const normalizedTx = txHash.toLowerCase();
  if (consumedTxHashes.has(normalizedTx)) {
    return { ok: false, reason: "TX_ALREADY_CONSUMED" };
  }

  const inFlight =
    fetchOrOptions && typeof fetchOrOptions === "object" ? fetchOrOptions.inFlightTxHashes : null;
  if (inFlight && inFlight.has(normalizedTx)) {
    return { ok: false, reason: "TX_VERIFICATION_IN_PROGRESS" };
  }
  if (inFlight) inFlight.add(normalizedTx);

  try {
    const receiptRes = await fetchReceipt(normalizedTx, fetchOrOptions);
    if (!receiptRes.ok) {
      return { ok: false, reason: receiptRes.reason };
    }
    const receipt = receiptRes.receipt;
    if (!receipt || receipt.status !== "0x1") {
      return { ok: false, reason: "TX_NOT_CONFIRMED_OR_FAILED" };
    }

    if (receipt.from) {
      const originHit = checkAddressSanctions(receipt.from);
      if (originHit) {
        return { ok: false, reason: "PAYER_BLOCKED_BY_AML", payerAddress: originHit.address, sanction: originHit };
      }
    }

    const treasuryTopic = "0x" + TREASURY_ADDRESS.toLowerCase().slice(2).padStart(64, "0");
    const matchingLogs = (receipt.logs || []).filter((log) => {
      if (!log?.address || log.address.toLowerCase() !== BASE_USDC_ADDRESS) return false;
      if (!Array.isArray(log.topics) || log.topics.length < 3) return false;
      if (!isValidTxHash(log.topics[1]) || !isValidTxHash(log.topics[2])) return false;
      if (log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) return false;
      return log.topics[2].toLowerCase() === treasuryTopic;
    });

    if (matchingLogs.length === 0) {
      return { ok: false, reason: "NO_USDC_TRANSFER_TO_TREASURY" };
    }

    let transferredUnits = 0n;
    const payers = new Set();
    for (const log of matchingLogs) {
      if (log.data !== undefined && log.data !== null && typeof log.data !== "string") {
        return { ok: false, reason: "INVALID_TRANSFER_LOG_DATA" };
      }
      const rawData = typeof log.data === "string" ? log.data.trim() : "";
      if (rawData !== "" && rawData !== "0x" && !/^0x[0-9a-fA-F]+$/.test(rawData)) {
        return { ok: false, reason: "INVALID_TRANSFER_LOG_DATA" };
      }
      let amount;
      try {
        amount = BigInt(rawData && rawData !== "0x" ? rawData : "0x0");
      } catch {
        return { ok: false, reason: "INVALID_TRANSFER_LOG_DATA" };
      }
      transferredUnits += amount;
      const payer = "0x" + log.topics[1].slice(-40).toLowerCase();
      payers.add(payer);
      const sanction = checkAddressSanctions(payer);
      if (sanction) {
        return { ok: false, reason: "PAYER_BLOCKED_BY_AML", payerAddress: payer, sanction };
      }
    }

    if (transferredUnits < BigInt(minAmountUnits)) {
      return {
        ok: false,
        reason: "INSUFFICIENT_USDC_AMOUNT",
        transferredUnits: transferredUnits.toString()
      };
    }

    if (consumedTxHashes.has(normalizedTx)) {
      return { ok: false, reason: "TX_ALREADY_CONSUMED" };
    }
    consumedTxHashes.add(normalizedTx);

    const primaryPayer = payers.values().next().value;
    return {
      ok: true,
      txHash: normalizedTx,
      payerAddress: primaryPayer,
      transferredUnits: transferredUnits.toString(),
      payerVerdict: "ALLOW"
    };
  } finally {
    if (inFlight) inFlight.delete(normalizedTx);
  }
}

export function parseApiKeyStore(rawKeys) {
  if (!rawKeys) return new Set();
  if (rawKeys instanceof Set || rawKeys instanceof Map) return rawKeys;
  if (Array.isArray(rawKeys)) {
    return new Set(rawKeys.map((k) => String(k).trim()).filter(Boolean));
  }
  return new Set(
    String(rawKeys)
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
  );
}

function getHeaderCaseInsensitive(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return null;
}

/**
 * Authorizes an incoming API request via verified B2B `X-Api-Key` or Base USDC `X-Payment-Tx`.
 */
export async function authorizeRequest({
  headers,
  resourcePath,
  priceUsdcUnits = DEFAULT_PRICE_USDC_UNITS,
  apiKeys = new Set(),
  consumedTxHashes,
  inFlightTxHashes,
  fetchImpl = fetch,
  rpcPool = null
}) {
  const apiKey = getHeaderCaseInsensitive(headers, "x-api-key");
  const paymentTx = getHeaderCaseInsensitive(headers, "x-payment-tx");

  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    const trimmedKey = apiKey.trim();
    if (apiKeys instanceof Map) {
      const record = apiKeys.get(trimmedKey);
      if (!record) {
        return {
          ok: false,
          status: 401,
          body: { error: "INVALID_API_KEY", ...build402Payload(priceUsdcUnits, resourcePath) }
        };
      }
      if (record.kycStatus !== "VERIFIED") {
        return {
          ok: false,
          status: 403,
          body: { error: "B2B_KYC_VERIFICATION_REQUIRED", kycStatus: record.kycStatus || "UNKNOWN" }
        };
      }
      return { ok: true, authMethod: "api-key", tier: record.tier || "b2b", paymentReceipt: null };
    }

    if (apiKeys instanceof Set && apiKeys.has(trimmedKey)) {
      return { ok: true, authMethod: "api-key", tier: "b2b", paymentReceipt: null };
    }

    return {
      ok: false,
      status: 401,
      body: { error: "INVALID_API_KEY", ...build402Payload(priceUsdcUnits, resourcePath) }
    };
  }

  if (typeof paymentTx === "string" && paymentTx.trim().length > 0) {
    const verification = await verifyBaseUsdcPayment(paymentTx.trim(), priceUsdcUnits, consumedTxHashes, {
      fetchImpl,
      rpcPool,
      inFlightTxHashes
    });
    if (!verification.ok) {
      const status = verification.reason === "PAYER_BLOCKED_BY_AML" ? 403 : 402;
      return {
        ok: false,
        status,
        body: {
          ...build402Payload(priceUsdcUnits, resourcePath),
          paymentError: verification.reason
        }
      };
    }
    return { ok: true, authMethod: "x402", paymentReceipt: verification };
  }

  return {
    ok: false,
    status: 402,
    body: build402Payload(priceUsdcUnits, resourcePath)
  };
}

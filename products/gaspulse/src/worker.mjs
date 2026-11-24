/**
 * Cloudflare Worker Entrypoint for GasPulse & Mempool Guard.
 * Zero Node.js built-ins; shares app.mjs, rpc_pool.mjs, gas_pulse.mjs, and x402.mjs cleanly.
 */
import { createGasPulseHandler } from "./app.mjs";
import { createReplayStore } from "./x402.mjs";

function resolveTimeoutMs(env, baseOptions) {
  if (env?.RPC_TIMEOUT_MS !== undefined && env?.RPC_TIMEOUT_MS !== null && env?.RPC_TIMEOUT_MS !== "") {
    const parsed = Number(env.RPC_TIMEOUT_MS);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const fallback = Number(baseOptions?.timeoutMs);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 4000;
}

function buildConfigKey(env, baseOptions) {
  return [
    baseOptions.apiKeys !== undefined ? "__fixed_keys__" : env?.GASPULSE_API_KEYS ?? "",
    baseOptions.rpcOverrides !== undefined ? "__fixed_rpcs__" : env?.BASE_RPCS ?? "",
    baseOptions.rpcOverrides !== undefined ? "" : env?.ETHEREUM_RPCS ?? "",
    baseOptions.rpcOverrides !== undefined ? "" : env?.ARBITRUM_RPCS ?? "",
    String(resolveTimeoutMs(env, baseOptions))
  ].join("|");
}

export function createWorkerHandler(baseOptions = {}) {
  const replayStore = baseOptions.consumedTxHashes || createReplayStore(10000);
  const inFlight = baseOptions.inFlightTxHashes || new Set();
  let cachedKey = null;
  let cachedHandler = null;

  return {
    async fetch(request, env = {}, _ctx) {
      const key = buildConfigKey(env, baseOptions);
      if (!cachedHandler || cachedKey !== key) {
        cachedKey = key;
        cachedHandler = createGasPulseHandler({
          fetchImpl: baseOptions.fetchImpl || fetch,
          rpcPool: baseOptions.rpcPool || null,
          apiKeys: baseOptions.apiKeys ?? (env?.GASPULSE_API_KEYS || ""),
          rpcOverrides: baseOptions.rpcOverrides ?? {
            base: env?.BASE_RPCS,
            ethereum: env?.ETHEREUM_RPCS,
            arbitrum: env?.ARBITRUM_RPCS
          },
          timeoutMs: resolveTimeoutMs(env, baseOptions),
          priceUsdcUnits: baseOptions.priceUsdcUnits,
          consumedTxHashes: replayStore,
          inFlightTxHashes: inFlight
        });
      }
      return cachedHandler(request);
    }
  };
}

export default createWorkerHandler();

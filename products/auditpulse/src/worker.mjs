/**
 * Cloudflare Worker Entrypoint for AuditPulse
 * Shares 100% of routing, x402 verification, inspector, and diff logic via src/handler.mjs.
 */
import { createAuditPulseHandler, parseApiKeySet } from "./handler.mjs";
import { createBoundedReplayStore } from "./x402.mjs";

const isolateReplayStore = createBoundedReplayStore(10000);

function buildRpcOverridesFromEnv(env) {
  const overrides = {};
  if (env?.BASE_RPC_URL) overrides.base = env.BASE_RPC_URL;
  if (env?.ETH_RPC_URL) overrides.ethereum = env.ETH_RPC_URL;
  if (env?.ARB_RPC_URL) overrides.arbitrum = env.ARB_RPC_URL;
  return overrides;
}

export function createWorker({ fetchImpl = fetch, consumedTxHashes } = {}) {
  const replayStore = consumedTxHashes || createBoundedReplayStore(10000);
  return {
    async fetch(request, env = {}) {
      const handler = createAuditPulseHandler({
        fetchImpl,
        apiKeys: parseApiKeySet(env?.AUDITPULSE_API_KEYS),
        consumedTxHashes: replayStore,
        rpcOverrides: buildRpcOverridesFromEnv(env)
      });
      return handler(request);
    }
  };
}

export default createWorker({ consumedTxHashes: isolateReplayStore });

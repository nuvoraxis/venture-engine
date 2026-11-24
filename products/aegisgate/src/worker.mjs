/**
 * AegisGate Cloudflare Workers Entry (Fetch Handler)
 * Delegates all routing, screening, and x402 verification to shared app.mjs / risk_engine.mjs / x402.mjs.
 */
import { createAegisHandler } from "./app.mjs";

const defaultHandler = createAegisHandler();

export function createWorkerHandler(options = {}) {
  const handler = createAegisHandler(options);
  return {
    async fetch(request, env = {}, ctx) {
      return handler(request, { env, ctx });
    }
  };
}

export default {
  async fetch(request, env = {}, ctx) {
    return defaultHandler(request, { env, ctx });
  }
};

/**
 * AegisGate Vercel Edge Function Entry
 * Shares risk_engine.mjs, x402.mjs, and app.mjs with zero duplicated logic.
 */
import { createAegisHandler } from "../src/app.mjs";

export const config = {
  runtime: "edge"
};

const defaultHandler = createAegisHandler();

export function createEdgeHandler(options = {}) {
  const handler = createAegisHandler(options);
  return async function edgeHandler(request) {
    const env = typeof globalThis.process !== "undefined" ? globalThis.process.env : {};
    return handler(request, { env });
  };
}

export default async function edgeHandler(request) {
  const env = typeof globalThis.process !== "undefined" ? globalThis.process.env : {};
  return defaultHandler(request, { env });
}

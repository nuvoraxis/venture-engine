/**
 * Venture Engine Portal — Cloudflare Workers Fetch Entrypoint
 * Zero node:* imports; shares routing, KYB gate, and Base USDC verification with app.mjs.
 */
import { createPortalHandler } from "./app.mjs";
import { createBoundedReplayStore, createBoundedInvoiceStore } from "./kyb_gate.mjs";

const isolateReplayStore = createBoundedReplayStore(10000);
const isolateInvoiceStore = createBoundedInvoiceStore(10000);

export function createWorkerHandler(options = {}) {
  const handler = createPortalHandler({
    consumedTxHashes: options.consumedTxHashes || createBoundedReplayStore(10000),
    issuedInvoices: options.issuedInvoices || createBoundedInvoiceStore(10000),
    ...options
  });
  return {
    async fetch(request, env = {}, ctx) {
      return handler(request, { env, ctx, rpcUrl: env?.BASE_RPC_URL });
    }
  };
}

const defaultWorker = createWorkerHandler({
  consumedTxHashes: isolateReplayStore,
  issuedInvoices: isolateInvoiceStore
});

export default defaultWorker;

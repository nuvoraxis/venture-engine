/**
 * Venture Engine Unified Gateway — Cloudflare Workers Fetch Entrypoint
 * Zero node:* imports; routes Portal, /aegis/*, /gaspulse/*, /auditpulse/*, and POST /mcp.
 */
import { createGatewayHandler } from "./gateway.mjs";
import { createBoundedInvoiceStore, createBoundedReplayStore } from "../../portal/src/kyb_gate.mjs";

const isolateReplayStore = createBoundedReplayStore(10000);
const isolateInvoiceStore = createBoundedInvoiceStore(10000);

export function createWorkerHandler(options = {}) {
  const handleGatewayRequest = createGatewayHandler({
    consumedTxHashes: options.consumedTxHashes || createBoundedReplayStore(10000),
    issuedInvoices: options.issuedInvoices || createBoundedInvoiceStore(10000),
    ...options
  });
  return {
    async fetch(request, env = {}, ctx) {
      return handleGatewayRequest(request, { env, ctx });
    }
  };
}

export default createWorkerHandler({
  consumedTxHashes: isolateReplayStore,
  issuedInvoices: isolateInvoiceStore
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_USDC_ADDRESS,
  DEFAULT_GATEWAY_URL,
  RECEIVE_ONLY_TREASURY,
  VentureEngineClient,
  VentureEngineError
} from "../src/index.mjs";

test("VentureEngineClient sends exact paths, query params, bodies, and auth headers across all 9 methods", async () => {
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true, url }), { status: 200 });
  };

  const client = new VentureEngineClient({
    apiKey: "ve_live_default",
    fetchImpl: mockFetch
  });

  assert.equal(client.baseUrl, DEFAULT_GATEWAY_URL);
  assert.equal(RECEIVE_ONLY_TREASURY, "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c");
  assert.equal(BASE_USDC_ADDRESS, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");

  await client.screenAddress("0x2222222222222222222222222222222222222222", { chain: "ethereum" });
  await client.estimateGas("arbitrum");
  await client.simulateTransaction({ chain: "base", to: "0x2222222222222222222222222222222222222222" });
  await client.rpcHealth({ chain: "base", probe: true });
  await client.inspectContract("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", {
    chain: "base",
    tokens: ["0x1111111111111111111111111111111111111111"]
  });
  await client.diffSnapshots({ previous: { address: "0x2222222222222222222222222222222222222222" }, format: "slack" });
  await client.kybCheckout({ companyName: "Acme Ltd", jurisdiction: "AE", plan: "starter" });
  await client.verifyInvoice({ invoiceId: "inv_1234", txHash: "0x" + "a".repeat(64) });
  await client.callMcpTool("estimate_gas", { chain: "base" }, { apiKey: null, paymentTx: "0x" + "b".repeat(64) });

  assert.equal(calls.length, 9);
  assert.equal(calls[0].url, `${DEFAULT_GATEWAY_URL}/aegis/v1/screen?address=0x2222222222222222222222222222222222222222&chain=ethereum`);
  assert.equal(calls[0].headers["X-Api-Key"], "ve_live_default");

  assert.equal(calls[1].url, `${DEFAULT_GATEWAY_URL}/gaspulse/v1/gas?chain=arbitrum`);
  assert.equal(calls[2].url, `${DEFAULT_GATEWAY_URL}/gaspulse/v1/simulate`);
  assert.equal(calls[2].method, "POST");
  assert.equal(calls[3].url, `${DEFAULT_GATEWAY_URL}/gaspulse/v1/rpc-health?chain=base&probe=true`);
  assert.equal(calls[4].url, `${DEFAULT_GATEWAY_URL}/auditpulse/v1/inspect?address=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&chain=base&tokens=0x1111111111111111111111111111111111111111`);
  assert.equal(calls[5].url, `${DEFAULT_GATEWAY_URL}/auditpulse/v1/diff`);
  assert.equal(calls[6].url, `${DEFAULT_GATEWAY_URL}/v1/kyb-checkout`);
  assert.equal(calls[7].url, `${DEFAULT_GATEWAY_URL}/v1/verify-invoice`);
  assert.equal(calls[8].url, `${DEFAULT_GATEWAY_URL}/mcp`);
  assert.equal(calls[8].headers["X-Api-Key"], undefined);
  assert.equal(calls[8].headers["X-Payment-Tx"], "0x" + "b".repeat(64));
  assert.equal(calls[8].body.method, "tools/call");
  assert.equal(calls[8].body.params.name, "estimate_gas");
});

test("VentureEngineClient throws VentureEngineError with status and x402 body on HTTP 402", async () => {
  const client = new VentureEngineClient({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: "Payment Required",
          protocol: "x402",
          accepts: [{ payTo: RECEIVE_ONLY_TREASURY, maxAmountRequired: "10000" }]
        }),
        { status: 402 }
      )
  });

  await assert.rejects(
    () => client.estimateGas("base"),
    (err) =>
      err instanceof VentureEngineError &&
      err.status === 402 &&
      err.body.accepts[0].payTo === RECEIVE_ONLY_TREASURY
  );
});

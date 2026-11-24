import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CANONICAL_CHAINS, screenEvmAddress } from "../src/risk_engine.mjs";
import { verifyBaseUsdcPayment, TREASURY_ADDRESS, BASE_USDC_ADDRESS, ERC20_TRANSFER_TOPIC } from "../src/x402.mjs";
import { createAegisServer } from "../src/server.mjs";
import worker, { createWorkerHandler } from "../src/worker.mjs";
import edgeHandler from "../api/edge.mjs";

const PROJECT_ROOT = new URL("../", import.meta.url);

function readProjectFile(relPath) {
  return readFileSync(new URL(relPath, PROJECT_ROOT), "utf8");
}

function makeMockRpcFetch(overrides = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const method = body.method;
    let result = "0x0";
    if (method === "eth_getBalance") result = overrides.balance ?? "0x100";
    if (method === "eth_getTransactionCount") result = overrides.nonce ?? "0x5";
    if (method === "eth_getCode") result = overrides.code ?? "0x";
    if (method === "eth_getStorageAt") result = overrides.storage ?? "0x0";
    if (method === "eth_getTransactionReceipt") result = overrides.receipt ?? null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
}

function makeUsdcReceipt(txPayerHex = "3".repeat(40), unitsHex = "0x2710") {
  const payerTopic = "0x" + txPayerHex.padStart(64, "0");
  const treasuryTopic = "0x" + TREASURY_ADDRESS.slice(2).padStart(64, "0");
  return {
    status: "0x1",
    logs: [
      {
        address: BASE_USDC_ADDRESS,
        topics: [ERC20_TRANSFER_TOPIC, payerTopic, treasuryTopic],
        data: unitsHex
      }
    ]
  };
}

test("blocks known OFAC/mixer address with riskScore 100", async () => {
  const report = await screenEvmAddress(
    "0x8589427373d6d84e98730d7795d8f6f8731fda16",
    "base",
    makeMockRpcFetch()
  );
  assert.equal(report.verdict, "BLOCK");
  assert.equal(report.riskScore, 100);
});

test("detects EIP-1967 upgradeable proxy contract", async () => {
  const implSlot = "0x0000000000000000000000001111111111111111111111111111111111111111";
  const report = await screenEvmAddress(
    "0x2222222222222222222222222222222222222222",
    "base",
    makeMockRpcFetch({ code: "0x60806040", storage: implSlot })
  );
  assert.equal(report.isContract, true);
  assert.equal(report.isEip1967Proxy, true);
  assert.equal(report.implementationAddress, "0x1111111111111111111111111111111111111111");
  assert.equal(report.verdict, "ALLOW");
});

test("verifies valid Base USDC x402 receipt and prevents replay", async () => {
  const txHash = "0x" + "a".repeat(64);
  const mockFetch = makeMockRpcFetch({ receipt: makeUsdcReceipt() });

  const consumed = new Set();
  const first = await verifyBaseUsdcPayment(txHash, 10000n, consumed, mockFetch);
  assert.equal(first.ok, true);
  assert.equal(first.transferredUnits, "10000");

  const replay = await verifyBaseUsdcPayment(txHash, 10000n, consumed, mockFetch);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "TX_ALREADY_CONSUMED");
});

test("HTTP server returns 402 without payment and 200 with valid API key", async () => {
  const server = createAegisServer({
    fetchImpl: makeMockRpcFetch(),
    apiKeys: new Set(["test-b2b-key"])
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const r402 = await fetch(`http://127.0.0.1:${port}/v1/screen?address=0x2222222222222222222222222222222222222222`);
    assert.equal(r402.status, 402);
    const body402 = await r402.json();
    assert.equal(body402.protocol, "x402");

    const r200 = await fetch(`http://127.0.0.1:${port}/v1/screen?address=0x2222222222222222222222222222222222222222`, {
      headers: { "X-Api-Key": "test-b2b-key" }
    });
    assert.equal(r200.status, 200);
    const body200 = await r200.json();
    assert.equal(body200.report.verdict, "ALLOW");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HTTP server serves /health, /v1/pricing, /openapi.json, /, and 404", async () => {
  const server = createAegisServer({ fetchImpl: makeMockRpcFetch() });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.status, "ok");
    assert.equal(health.service, "aegisgate");
    assert.equal(health.treasury, TREASURY_ADDRESS);

    const pricingRes = await fetch(`http://127.0.0.1:${port}/v1/pricing`);
    assert.equal(pricingRes.status, 200);
    const pricing = await pricingRes.json();
    assert.equal(pricing.x402_per_call_usdc, "0.01");
    assert.equal(pricing.treasury, TREASURY_ADDRESS);

    const openapiRes = await fetch(`http://127.0.0.1:${port}/openapi.json`);
    assert.equal(openapiRes.status, 200);
    const openapi = await openapiRes.json();
    assert.equal(openapi.openapi, "3.1.0");
    assert.ok(openapi.paths["/v1/screen"]);

    const landingRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(landingRes.status, 200);
    assert.match(landingRes.headers.get("content-type") || "", /text\/html/);
    const html = await landingRes.text();
    assert.match(html, /AegisGate/);
    assert.ok(html.includes(TREASURY_ADDRESS));

    const notFoundRes = await fetch(`http://127.0.0.1:${port}/does-not-exist`);
    assert.equal(notFoundRes.status, 404);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Cloudflare Worker default fetch handler serves health, pricing, OpenAPI 3.1, CORS, landing, and 404", async () => {
  const healthRes = await worker.fetch(new Request("https://aegisgate.workers.dev/health"));
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.headers.get("access-control-allow-origin"), "*");
  const health = await healthRes.json();
  assert.equal(health.status, "ok");
  assert.equal(health.service, "aegisgate");
  assert.equal(health.treasury, TREASURY_ADDRESS);
  assert.deepEqual(health.chains, ["base", "ethereum", "arbitrum"]);

  const pricingRes = await worker.fetch(new Request("https://aegisgate.workers.dev/v1/pricing"));
  assert.equal(pricingRes.status, 200);
  const pricing = await pricingRes.json();
  assert.equal(pricing.x402_per_call_usdc, "0.01");
  assert.equal(pricing.openapi, "/openapi.json");

  const openapiRes = await worker.fetch(new Request("https://aegisgate.workers.dev/openapi.json"));
  assert.equal(openapiRes.status, 200);
  assert.equal(openapiRes.headers.get("access-control-allow-origin"), "*");
  const spec = await openapiRes.json();
  const diskSpec = JSON.parse(readProjectFile("public/openapi.json"));
  assert.deepEqual(spec, diskSpec);
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.paths["/health"]);
  assert.ok(spec.paths["/v1/pricing"]);
  assert.ok(spec.paths["/openapi.json"]);
  assert.ok(spec.paths["/v1/screen"]);
  assert.ok(spec.components.securitySchemes.ApiKeyAuth);
  assert.ok(spec.components.securitySchemes.X402PaymentTx);

  const preflightRes = await worker.fetch(
    new Request("https://aegisgate.workers.dev/v1/screen", { method: "OPTIONS" })
  );
  assert.equal(preflightRes.status, 204);
  assert.equal(preflightRes.headers.get("access-control-allow-origin"), "*");

  const fallbackHomeRes = await worker.fetch(new Request("https://aegisgate.workers.dev/"));
  assert.equal(fallbackHomeRes.status, 200);
  const fallbackHtml = await fallbackHomeRes.text();
  assert.match(fallbackHtml, /AegisGate/);
  assert.ok(fallbackHtml.includes(TREASURY_ADDRESS));

  const assetEnv = {
    ASSETS: {
      async fetch(req) {
        if (new URL(req.url).pathname === "/") {
          return new Response(readProjectFile("public/index.html"), {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
        return new Response("Not found", { status: 404 });
      }
    }
  };
  const assetHomeRes = await worker.fetch(new Request("https://aegisgate.workers.dev/"), assetEnv);
  assert.equal(assetHomeRes.status, 200);
  const assetHtml = await assetHomeRes.text();
  assert.match(assetHtml, /Self-Serve Endpoint Explorer/);

  const unknownRes = await worker.fetch(new Request("https://aegisgate.workers.dev/unknown-route"), assetEnv);
  assert.equal(unknownRes.status, 404);
  const unknownBody = await unknownRes.json();
  assert.equal(unknownBody.error, "Not Found");
});

test("Cloudflare Worker fetch handler enforces x402 payment, B2B env keys, replay protection, and error handling", async () => {
  const txHash = "0x" + "b".repeat(64);
  const workerApp = createWorkerHandler({
    fetchImpl: makeMockRpcFetch({ receipt: makeUsdcReceipt() })
  });
  const env = { AEGISGATE_API_KEYS: "b2b_alpha, b2b_beta" };

  // 1. Unauthenticated -> 402 x402 challenge
  const unauthRes = await workerApp.fetch(
    new Request("https://aegisgate.workers.dev/v1/screen?address=0x2222222222222222222222222222222222222222"),
    env
  );
  assert.equal(unauthRes.status, 402);
  const challenge = await unauthRes.json();
  assert.equal(challenge.protocol, "x402");
  assert.equal(challenge.accepts[0].payTo, TREASURY_ADDRESS);
  assert.equal(challenge.accepts[0].maxAmountRequired, "10000");

  // 2. Valid env B2B API key -> 200 risk report (OFAC address blocked)
  const apiKeyRes = await workerApp.fetch(
    new Request("https://aegisgate.workers.dev/v1/screen?address=0x8589427373d6d84e98730d7795d8f6f8731fda16&chain=base", {
      headers: { "X-Api-Key": "b2b_beta" }
    }),
    env
  );
  assert.equal(apiKeyRes.status, 200);
  const apiKeyBody = await apiKeyRes.json();
  assert.equal(apiKeyBody.report.verdict, "BLOCK");
  assert.equal(apiKeyBody.report.riskScore, 100);
  assert.equal(apiKeyBody.paymentReceipt, null);

  // 3. Valid X-Payment-Tx -> 200 with paymentReceipt
  const paidRes = await workerApp.fetch(
    new Request("https://aegisgate.workers.dev/v1/screen?address=0x2222222222222222222222222222222222222222&chain=arbitrum", {
      headers: { "X-Payment-Tx": txHash }
    }),
    env
  );
  assert.equal(paidRes.status, 200);
  const paidBody = await paidRes.json();
  assert.equal(paidBody.report.chain, "arbitrum");
  assert.equal(paidBody.report.verdict, "ALLOW");
  assert.equal(paidBody.paymentReceipt.ok, true);
  assert.equal(paidBody.paymentReceipt.txHash, txHash);

  // 4. Replay of same X-Payment-Tx -> 402 TX_ALREADY_CONSUMED
  const replayRes = await workerApp.fetch(
    new Request("https://aegisgate.workers.dev/v1/screen?address=0x2222222222222222222222222222222222222222", {
      headers: { "X-Payment-Tx": txHash }
    }),
    env
  );
  assert.equal(replayRes.status, 402);
  const replayBody = await replayRes.json();
  assert.equal(replayBody.paymentError, "TX_ALREADY_CONSUMED");

  // 5. Invalid EVM address with valid key -> 400 Bad Request
  const badAddrRes = await workerApp.fetch(
    new Request("https://aegisgate.workers.dev/v1/screen?address=not-hex", {
      headers: { "X-Api-Key": "b2b_alpha" }
    }),
    env
  );
  assert.equal(badAddrRes.status, 400);
  const badAddrBody = await badAddrRes.json();
  assert.match(badAddrBody.error, /Invalid EVM address/);
});

test("Vercel Edge handler serves /health and /openapi.json", async () => {
  const healthRes = await edgeHandler(new Request("https://aegisgate.vercel.app/health"));
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.status, "ok");
  assert.equal(health.treasury, TREASURY_ADDRESS);

  const specRes = await edgeHandler(new Request("https://aegisgate.vercel.app/openapi.json"));
  assert.equal(specRes.status, 200);
  const spec = await specRes.json();
  assert.equal(spec.openapi, "3.1.0");
});

test("fails over across CANONICAL_CHAINS.rpcs on HTTP 500/429, network error, and upstream RPC gateway error", async () => {
  assert.equal(CANONICAL_CHAINS.ethereum.rpc, CANONICAL_CHAINS.ethereum.rpcs[0]);
  assert.equal(CANONICAL_CHAINS.ethereum.rpcs[0], "https://ethereum-rpc.publicnode.com");
  assert.deepEqual(CANONICAL_CHAINS.ethereum.rpcs, [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com"
  ]);
  assert.deepEqual(CANONICAL_CHAINS.base.rpcs, [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com"
  ]);
  assert.deepEqual(CANONICAL_CHAINS.arbitrum.rpcs, [
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum-one-rpc.publicnode.com"
  ]);

  const seenUrls = [];
  const failoverFetch = async (url, init) => {
    seenUrls.push(url);
    if (url === "https://ethereum-rpc.publicnode.com") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32046, message: "Internal error" } }),
        { status: 200 }
      );
    }
    if (url === "https://eth.llamarpc.com") {
      return new Response("upstream busy", { status: 503 });
    }
    const body = JSON.parse(init.body);
    let result = "0x0";
    if (body.method === "eth_getBalance") result = "0x200";
    if (body.method === "eth_getTransactionCount") result = "0x7";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };

  const report = await screenEvmAddress(
    "0x2222222222222222222222222222222222222222",
    "ethereum",
    failoverFetch
  );
  assert.equal(report.chainId, 1);
  assert.equal(report.nonce, 7);
  assert.equal(report.nativeBalanceWei, "512");
  assert.ok(seenUrls.includes("https://ethereum-rpc.publicnode.com"));
  assert.ok(seenUrls.includes("https://eth.llamarpc.com"));
  assert.ok(seenUrls.includes("https://cloudflare-eth.com"));

  // Base x402 verification also fails over on HTTP 429 / network error
  const txHash = "0x" + "c".repeat(64);
  const baseSeen = [];
  const baseFailoverFetch = async (url, init) => {
    baseSeen.push(url);
    if (url === "https://mainnet.base.org") {
      return new Response("rate limited", { status: 429 });
    }
    const body = JSON.parse(init.body);
    const result = body.method === "eth_getTransactionReceipt" ? makeUsdcReceipt() : "0x1";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
  const paid = await verifyBaseUsdcPayment(txHash, 10000n, new Set(), baseFailoverFetch);
  assert.equal(paid.ok, true);
  assert.ok(baseSeen.includes("https://mainnet.base.org"));
  assert.ok(baseSeen.includes("https://base-rpc.publicnode.com"));
});

test("distribution manifests and docs contain valid metadata with zero PII or secrets", () => {
  const mcp = JSON.parse(readProjectFile("mcp.json"));
  assert.equal(mcp.name, "aegisgate-mcp");
  assert.equal(mcp.payment.treasury, TREASURY_ADDRESS);
  assert.equal(mcp.payment.receiveOnly, true);
  assert.equal(mcp.capabilities.tools[0].name, "screen_evm_address");

  const filesToAudit = [
    "public/index.html",
    "public/openapi.json",
    "mcp.json",
    "DEPLOY.md",
    "README.md",
    "wrangler.toml",
    "vercel.json",
    "src/app.mjs",
    "src/worker.mjs",
    "src/server.mjs",
    "api/edge.mjs"
  ];

  const userPathPattern = new RegExp(["[A-Za-z]:", "Users", ""].join("\\\\"), "i");
  const privKeyAssignPattern = new RegExp(["PRIVATE", "KEY\\s*="].join("_"));
  const mnemonicAssignPattern = new RegExp(["MNEMONIC", "\\s*="].join(""));

  for (const rel of filesToAudit) {
    const content = readProjectFile(rel);
    assert.equal(userPathPattern.test(content), false, `Local user path leaked in ${rel}`);
    assert.equal(privKeyAssignPattern.test(content), false, `Private key pattern found in ${rel}`);
    assert.equal(mnemonicAssignPattern.test(content), false, `Mnemonic pattern found in ${rel}`);
  }
});

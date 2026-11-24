import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TREASURY_ADDRESS,
  BASE_USDC_ADDRESS,
  ERC20_TRANSFER_TOPIC,
  B2B_PLANS,
  createBoundedReplayStore,
  validateKybSubmission,
  computeDeterministicInvoiceId,
  verifyBaseUsdcPayment
} from "../src/kyb_gate.mjs";
import { createPortalServer } from "../src/server.mjs";
import worker, { createWorkerHandler } from "../src/worker.mjs";

const PORTAL_ROOT = new URL("../", import.meta.url);

function readPortalFile(relPath) {
  return readFileSync(new URL(relPath, PORTAL_ROOT), "utf8");
}

const VALID_KYB = {
  companyName: "Acme FinTech Labs Ltd",
  jurisdiction: "AE",
  contactDomain: "acme-fintech.io",
  payerAddress: "0x1111111111111111111111111111111111111111",
  plan: "starter",
  useCase: "Automated AML screening and EVM transaction simulation"
};

function makeMockRpcFetch({ receipt = null, httpStatus = 200 } = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    if (httpStatus !== 200) {
      return new Response("RPC error", { status: httpStatus });
    }
    const result = body.method === "eth_getTransactionReceipt" ? receipt : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
}

function toUnitsHex(units) {
  return "0x" + BigInt(units).toString(16);
}

function makeUsdcReceipt({
  payer = VALID_KYB.payerAddress,
  recipient = TREASURY_ADDRESS,
  token = BASE_USDC_ADDRESS,
  unitsHex = toUnitsHex(49000000n),
  status = "0x1"
} = {}) {
  const payerTopic = "0x" + payer.toLowerCase().slice(2).padStart(64, "0");
  const recipientTopic = "0x" + recipient.toLowerCase().slice(2).padStart(64, "0");
  return {
    status,
    logs: [
      {
        address: token,
        topics: [ERC20_TRANSFER_TOPIC, payerTopic, recipientTopic],
        data: unitsHex
      }
    ]
  };
}

test("KYB validator approves valid corporate entities and computes deterministic invoice IDs", async () => {
  const kyb = validateKybSubmission(VALID_KYB);
  assert.equal(kyb.ok, true);
  assert.equal(kyb.kybStatus, "APPROVED");
  assert.equal(kyb.normalized.jurisdiction, "AE");
  assert.equal(kyb.planConfig.amountUnits, B2B_PLANS.starter.amountUnits);

  const id1 = await computeDeterministicInvoiceId(kyb.normalized, kyb.planConfig);
  const id2 = await computeDeterministicInvoiceId(
    { ...kyb.normalized, companyName: "  ACME FINTECH LABS LTD  " },
    kyb.planConfig
  );
  assert.match(id1, /^inv_[0-9a-f]{24}$/);
  assert.equal(id1, id2);

  const growthId = await computeDeterministicInvoiceId(kyb.normalized, B2B_PLANS.growth);
  assert.notEqual(id1, growthId);
});

test("Fail-Closed KYB gate rejects sanctioned jurisdictions, disposable domains, anonymous entities, defense use cases, and OFAC addresses", () => {
  const prohibitedCases = [
    { label: "North Korea jurisdiction", patch: { jurisdiction: "KP" }, code: "PROHIBITED_JURISDICTION" },
    { label: "Iran jurisdiction", patch: { jurisdiction: "ir" }, code: "PROHIBITED_JURISDICTION" },
    { label: "Unknown XX jurisdiction", patch: { jurisdiction: "XX" }, code: "PROHIBITED_JURISDICTION" },
    { label: "Consumer Gmail domain", patch: { contactDomain: "gmail.com" }, code: "NON_CORPORATE_OR_DISPOSABLE_DOMAIN" },
    { label: "Disposable Mailinator subdomain", patch: { contactDomain: "ops.mailinator.com" }, code: "NON_CORPORATE_OR_DISPOSABLE_DOMAIN" },
    { label: "Darknet .onion domain", patch: { contactDomain: "vendor.onion" }, code: "PROHIBITED_DARKNET_DOMAIN" },
    { label: "Anonymous company name", patch: { companyName: "Anonymous Holdings" }, code: "ANONYMOUS_ENTITY_REJECTED" },
    { label: "Bare 0x company name", patch: { companyName: "0x1111111111111111111111111111111111111111" }, code: "ANONYMOUS_ENTITY_REJECTED" },
    { label: "Defense company name", patch: { companyName: "Apex Defense Systems" }, code: "PROHIBITED_ENTITY_OR_ACTIVITY" },
    { label: "Military useCase", patch: { useCase: "Military targeting and cyberwarfare" }, code: "PROHIBITED_USE_CASE" },
    { label: "Tornado Cash OFAC payer", patch: { payerAddress: "0x8589427373d6d84e98730d7795d8f6f8731fda16" }, code: "PAYER_BLOCKED_BY_AML" },
    { label: "Lazarus Group OFAC payer", patch: { payerAddress: "0x098b716b8aaf21512996dc57eb0615e2383e2f96" }, code: "PAYER_BLOCKED_BY_AML" },
    { label: "Treasury self-payer", patch: { payerAddress: TREASURY_ADDRESS }, code: "PROHIBITED_PAYER_ADDRESS" }
  ];

  for (const tc of prohibitedCases) {
    const res = validateKybSubmission({ ...VALID_KYB, ...tc.patch });
    assert.equal(res.ok, false, `Expected rejection for ${tc.label}`);
    assert.equal(res.httpStatus, 403, `Expected 403 for ${tc.label}`);
    assert.equal(res.code, tc.code, `Unexpected code for ${tc.label}`);
  }

  const malformedCases = [
    { patch: { companyName: "A" }, code: "INVALID_COMPANY_NAME" },
    { patch: { jurisdiction: "UAE" }, code: "INVALID_JURISDICTION" },
    { patch: { contactDomain: "ops@acme-fintech.io" }, code: "INVALID_CONTACT_DOMAIN" },
    { patch: { contactDomain: "localhost" }, code: "INVALID_CONTACT_DOMAIN" },
    { patch: { payerAddress: "0x1234" }, code: "INVALID_PAYER_ADDRESS" },
    { patch: { plan: "free" }, code: "INVALID_PLAN" }
  ];

  for (const tc of malformedCases) {
    const res = validateKybSubmission({ ...VALID_KYB, ...tc.patch });
    assert.equal(res.ok, false);
    assert.equal(res.httpStatus, 400);
    assert.equal(res.code, tc.code);
  }
});

test("Base USDC receipt verifier validates transfer to treasury, enforces amounts & payer match, and prevents replay", async () => {
  const txHash = "0x" + "a".repeat(64);
  const consumed = createBoundedReplayStore(100);
  const mockFetch = makeMockRpcFetch({ receipt: makeUsdcReceipt() });

  const okRes = await verifyBaseUsdcPayment(txHash, 49000000n, consumed, mockFetch, {
    expectedPayerAddress: VALID_KYB.payerAddress
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.transferredUnits, "49000000");
  assert.equal(okRes.payTo, TREASURY_ADDRESS);

  const replayRes = await verifyBaseUsdcPayment(txHash, 49000000n, consumed, mockFetch);
  assert.equal(replayRes.ok, false);
  assert.equal(replayRes.httpStatus, 402);
  assert.equal(replayRes.reason, "TX_ALREADY_CONSUMED");

  // Insufficient USDC amount (48,999,999 < 49,000,000)
  const shortRes = await verifyBaseUsdcPayment(
    "0x" + "b".repeat(64),
    49000000n,
    consumed,
    makeMockRpcFetch({ receipt: makeUsdcReceipt({ unitsHex: toUnitsHex(48999999n) }) })
  );
  assert.equal(shortRes.ok, false);
  assert.equal(shortRes.httpStatus, 402);
  assert.equal(shortRes.reason, "INSUFFICIENT_USDC_AMOUNT");

  // Wrong recipient
  const wrongDestRes = await verifyBaseUsdcPayment(
    "0x" + "c".repeat(64),
    49000000n,
    consumed,
    makeMockRpcFetch({ receipt: makeUsdcReceipt({ recipient: "0x2222222222222222222222222222222222222222" }) })
  );
  assert.equal(wrongDestRes.ok, false);
  assert.equal(wrongDestRes.reason, "NO_USDC_TRANSFER_TO_TREASURY");

  // OFAC payer in on-chain log
  const amlRes = await verifyBaseUsdcPayment(
    "0x" + "d".repeat(64),
    49000000n,
    consumed,
    makeMockRpcFetch({ receipt: makeUsdcReceipt({ payer: "0x8589427373d6d84e98730d7795d8f6f8731fda16" }) })
  );
  assert.equal(amlRes.ok, false);
  assert.equal(amlRes.httpStatus, 403);
  assert.equal(amlRes.reason, "PAYER_BLOCKED_BY_AML");

  // Payer mismatch vs KYB address
  const mismatchRes = await verifyBaseUsdcPayment(
    "0x" + "e".repeat(64),
    49000000n,
    consumed,
    makeMockRpcFetch({ receipt: makeUsdcReceipt({ payer: "0x2222222222222222222222222222222222222222" }) }),
    { expectedPayerAddress: VALID_KYB.payerAddress }
  );
  assert.equal(mismatchRes.ok, false);
  assert.equal(mismatchRes.httpStatus, 403);
  assert.equal(mismatchRes.reason, "PAYER_MISMATCH");
});

test("Cloudflare Worker fetch handler serves static/discovery routes, CORS, and 404/405", async () => {
  const healthRes = await worker.fetch(new Request("https://portal.venture-engine.workers.dev/health"));
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.headers.get("access-control-allow-origin"), "*");
  const health = await healthRes.json();
  assert.equal(health.status, "ok");
  assert.equal(health.service, "venture-engine-portal");
  assert.equal(health.treasury, TREASURY_ADDRESS);
  assert.equal(health.receiveOnly, true);

  const plansRes = await worker.fetch(new Request("https://portal.venture-engine.workers.dev/v1/plans"));
  assert.equal(plansRes.status, 200);
  const plans = await plansRes.json();
  assert.equal(plans.plans.starter.amountUnits, "49000000");
  assert.equal(plans.plans.growth.amountUnits, "199000000");
  assert.equal(plans.plans.enterprise.amountUnits, "499000000");

  const x402Res = await worker.fetch(new Request("https://portal.venture-engine.workers.dev/.well-known/x402.json"));
  assert.equal(x402Res.status, 200);
  assert.deepEqual(await x402Res.json(), JSON.parse(readPortalFile("public/.well-known/x402.json")));

  const openapiRes = await worker.fetch(new Request("https://portal.venture-engine.workers.dev/openapi.json"));
  assert.equal(openapiRes.status, 200);
  assert.deepEqual(await openapiRes.json(), JSON.parse(readPortalFile("public/openapi.json")));

  const llmsRes = await worker.fetch(new Request("https://portal.venture-engine.workers.dev/llms.txt"));
  assert.equal(llmsRes.status, 200);
  assert.match(llmsRes.headers.get("content-type") || "", /text\/plain/);
  const llmsBody = await llmsRes.text();
  assert.ok(llmsBody.includes(TREASURY_ADDRESS));

  const fallbackHomeRes = await worker.fetch(new Request("https://portal.venture-engine.workers.dev/"));
  assert.equal(fallbackHomeRes.status, 200);
  assert.match(await fallbackHomeRes.text(), /Venture Engine Portal/);

  const assetEnv = {
    ASSETS: {
      async fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/") {
          return new Response(readPortalFile("public/index.html"), {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
        return new Response("Not Found", { status: 404 });
      }
    }
  };
  const assetHomeRes = await worker.fetch(new Request("https://portal.venture-engine.workers.dev/"), assetEnv);
  assert.equal(assetHomeRes.status, 200);
  assert.match(await assetHomeRes.text(), /Self-Serve B2B Monthly Plans/);

  const optionsRes = await worker.fetch(
    new Request("https://portal.venture-engine.workers.dev/v1/kyb-checkout", { method: "OPTIONS" })
  );
  assert.equal(optionsRes.status, 204);

  const methodNotAllowed = await worker.fetch(
    new Request("https://portal.venture-engine.workers.dev/v1/kyb-checkout", { method: "GET" })
  );
  assert.equal(methodNotAllowed.status, 405);

  const notFoundRes = await worker.fetch(new Request("https://portal.venture-engine.workers.dev/missing"));
  assert.equal(notFoundRes.status, 404);
});

test("Cloudflare Worker handles 2-step KYB checkout, /v1/verify-invoice, and replay protection", async () => {
  const tx1 = "0x" + "1".repeat(64);
  const tx2 = "0x" + "2".repeat(64);
  const workerApp = createWorkerHandler({
    fetchImpl: makeMockRpcFetch({ receipt: makeUsdcReceipt({ unitsHex: toUnitsHex(199000000n) }) })
  });

  // 1. Fail-Closed KYB rejection
  const rejectedRes = await workerApp.fetch(
    new Request("https://portal.venture-engine.workers.dev/v1/kyb-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...VALID_KYB, contactDomain: "anon.yopmail.com" })
    })
  );
  assert.equal(rejectedRes.status, 403);
  const rejectedBody = await rejectedRes.json();
  assert.equal(rejectedBody.ok, false);
  assert.equal(rejectedBody.kybStatus, "REJECTED");

  // 2. Step 1: Valid KYB issues deterministic Growth invoice
  const growthPayload = { ...VALID_KYB, plan: "growth" };
  const step1Res = await workerApp.fetch(
    new Request("https://portal.venture-engine.workers.dev/v1/kyb-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(growthPayload)
    })
  );
  assert.equal(step1Res.status, 200);
  const step1Body = await step1Res.json();
  assert.equal(step1Body.ok, true);
  assert.equal(step1Body.status, "INVOICE_ISSUED");
  assert.equal(step1Body.kybStatus, "APPROVED");
  assert.equal(step1Body.paymentStatus, "AWAITING_PAYMENT");
  assert.match(step1Body.invoice.invoiceId, /^inv_[0-9a-f]{24}$/);
  assert.equal(step1Body.invoice.amountUnits, "199000000");
  assert.equal(step1Body.invoice.payTo, TREASURY_ADDRESS);

  // 3. Step 2 via /v1/verify-invoice confirms Base USDC payment and activates entitlement
  const verifyRes = await workerApp.fetch(
    new Request("https://portal.venture-engine.workers.dev/v1/verify-invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoiceId: step1Body.invoice.invoiceId, txHash: tx1 })
    })
  );
  assert.equal(verifyRes.status, 200);
  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.ok, true);
  assert.equal(verifyBody.status, "PAID_AND_VERIFIED");
  assert.equal(verifyBody.kybStatus, "VERIFIED");
  assert.equal(verifyBody.paymentStatus, "CONFIRMED");
  assert.equal(verifyBody.paymentReceipt.txHash, tx1);
  assert.equal(verifyBody.entitlement.status, "ACTIVE");
  assert.equal(verifyBody.entitlement.monthlyQuota, 150000);

  // 4. Replay of tx1 across /v1/kyb-checkout is blocked (402 TX_ALREADY_CONSUMED)
  const replayRes = await workerApp.fetch(
    new Request("https://portal.venture-engine.workers.dev/v1/kyb-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...growthPayload, invoiceId: step1Body.invoice.invoiceId, txHash: tx1 })
    })
  );
  assert.equal(replayRes.status, 402);
  const replayBody = await replayRes.json();
  assert.equal(replayBody.code, "TX_ALREADY_CONSUMED");

  // 5. Stateless /v1/verify-invoice verifies Base USDC receipt without activating entitlement when KYB not submitted
  const statelessRes = await workerApp.fetch(
    new Request("https://portal.venture-engine.workers.dev/v1/verify-invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "starter", txHash: tx2 })
    })
  );
  assert.equal(statelessRes.status, 200);
  const statelessBody = await statelessRes.json();
  assert.equal(statelessBody.ok, true);
  assert.equal(statelessBody.paymentStatus, "CONFIRMED");
  assert.equal(statelessBody.kybStatus, "NOT_SUBMITTED");
  assert.equal(statelessBody.entitlement, null);

  // 6. Missing plan and unknown invoiceId rejected Fail-Closed (400)
  const missingPlanRes = await workerApp.fetch(
    new Request("https://portal.venture-engine.workers.dev/v1/verify-invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash: "0x" + "f".repeat(64) })
    })
  );
  assert.equal(missingPlanRes.status, 400);
  assert.equal((await missingPlanRes.json()).code, "MISSING_INVOICE_OR_PLAN");

  // 7. Malformed JSON -> 400, oversized body -> 413
  const badJsonRes = await workerApp.fetch(
    new Request("https://portal.venture-engine.workers.dev/v1/kyb-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json"
    })
  );
  assert.equal(badJsonRes.status, 400);
  assert.equal((await badJsonRes.json()).code, "INVALID_JSON");

  const oversizedRes = await workerApp.fetch(
    new Request("https://portal.venture-engine.workers.dev/v1/kyb-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...VALID_KYB, useCase: "a".repeat(20000) })
    })
  );
  assert.equal(oversizedRes.status, 413);
  assert.equal((await oversizedRes.json()).code, "PAYLOAD_TOO_LARGE");
});

test("Node HTTP server serves portal routes and executes KYB checkout end-to-end", async () => {
  const txHash = "0x" + "9".repeat(64);
  const server = createPortalServer({
    fetchImpl: makeMockRpcFetch({ receipt: makeUsdcReceipt({ unitsHex: toUnitsHex(499000000n) }) })
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const homeRes = await fetch(`${baseUrl}/`);
    assert.equal(homeRes.status, 200);
    assert.match(homeRes.headers.get("content-type") || "", /text\/html/);
    assert.ok((await homeRes.text()).includes(TREASURY_ADDRESS));

    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    assert.equal((await healthRes.json()).treasury, TREASURY_ADDRESS);

    const checkoutRes = await fetch(`${baseUrl}/v1/kyb-checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...VALID_KYB, plan: "enterprise", txHash })
    });
    assert.equal(checkoutRes.status, 200);
    const body = await checkoutRes.json();
    assert.equal(body.status, "PAID_AND_VERIFIED");
    assert.equal(body.invoice.amountUnits, "499000000");
    assert.equal(body.entitlement.monthlyQuota, 1000000);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Portal source, wrangler.toml, and public assets preserve zero node:* imports in edge code and zero PII/secrets", () => {
  const edgeModules = ["src/kyb_gate.mjs", "src/app.mjs", "src/worker.mjs"];
  for (const rel of edgeModules) {
    const content = readPortalFile(rel);
    assert.equal(/from\s+["']node:/i.test(content), false, `Forbidden node:* import in ${rel}`);
  }

  const wrangler = readPortalFile("wrangler.toml");
  assert.match(wrangler, /^name\s*=/m);
  assert.match(wrangler, /^main\s*=\s*"src\/worker\.mjs"/m);
  assert.match(wrangler, /^compatibility_date\s*=/m);
  assert.match(wrangler, /\[assets\]/);
  assert.match(wrangler, /directory\s*=\s*"\.\/public"/);
  assert.ok(wrangler.includes(TREASURY_ADDRESS));

  const filesToAudit = [
    "package.json",
    "wrangler.toml",
    "README.md",
    "src/kyb_gate.mjs",
    "src/app.mjs",
    "src/worker.mjs",
    "src/server.mjs",
    "public/index.html",
    "public/llms.txt",
    "public/openapi.json",
    "public/.well-known/x402.json",
    "tests/portal.test.mjs"
  ];

  const userPathPattern = new RegExp(["[A-Za-z]:", "Users", ""].join("\\\\"), "i");
  const privKeyAssignPattern = new RegExp(["PRIVATE", "KEY\\s*="].join("_"));
  const mnemonicAssignPattern = new RegExp(["MNEMONIC", "\\s*="].join(""));
  const seedAssignPattern = new RegExp(["SEED", "PHRASE\\s*="].join("_"));
  const signingPattern = new RegExp(["eth_send", "Transaction|sign", "Transaction"].join(""));

  for (const rel of filesToAudit) {
    const content = readPortalFile(rel);
    assert.equal(userPathPattern.test(content), false, `Local user path leaked in ${rel}`);
    assert.equal(privKeyAssignPattern.test(content), false, `Private key pattern found in ${rel}`);
    assert.equal(mnemonicAssignPattern.test(content), false, `Mnemonic pattern found in ${rel}`);
    assert.equal(seedAssignPattern.test(content), false, `Seed phrase pattern found in ${rel}`);
    assert.equal(signingPattern.test(content), false, `Signing call pattern found in ${rel}`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TREASURY_ADDRESS,
  BASE_USDC_ADDRESS,
  ERC20_TRANSFER_TOPIC
} from "../../portal/src/kyb_gate.mjs";
import {
  TOKEN_PREFIX,
  constantTimeEqualBytes,
  issueApiToken,
  verifyApiToken,
  authenticateApiKeyHeader
} from "../src/auth_tokens.mjs";
import { ALL_MCP_TOOLS } from "../src/mcp_http.mjs";
import { createGatewayHandler } from "../src/gateway.mjs";
import worker, { createWorkerHandler } from "../src/worker.mjs";
import { createGatewayServer } from "../src/server.mjs";

const GATEWAY_ROOT = new URL("../", import.meta.url);
const TEST_SECRET = "ve_test_hmac_secret_32bytes_min_0123456789";

function readGatewayFile(relPath) {
  return readFileSync(new URL(relPath, GATEWAY_ROOT), "utf8");
}

function toUnitsHex(units) {
  return "0x" + BigInt(units).toString(16);
}

const VALID_KYB = {
  companyName: "Acme FinTech Labs Ltd",
  jurisdiction: "AE",
  contactDomain: "acme-fintech.io",
  payerAddress: "0x1111111111111111111111111111111111111111",
  plan: "starter"
};

function makeUsdcReceipt({
  payer = VALID_KYB.payerAddress,
  recipient = TREASURY_ADDRESS,
  token = BASE_USDC_ADDRESS,
  units = 49000000n,
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
        data: toUnitsHex(units)
      }
    ]
  };
}

function makeSuiteRpcFetch({ receiptsByTx = {}, defaultReceipt = null } = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const { method, params } = body;
    let result = "0x0";

    if (method === "eth_getTransactionReceipt") {
      const tx = String(params?.[0] || "").toLowerCase();
      result = receiptsByTx[tx] ?? defaultReceipt;
    } else if (method === "eth_blockNumber") {
      result = "0x1000000";
    } else if (method === "eth_chainId") {
      result = "0x2105"; // Base chainId 8453
    } else if (method === "eth_getBalance") {
      result = "0xde0b6b3a7640000"; // 1 ETH
    } else if (method === "eth_getTransactionCount") {
      result = "0x5";
    } else if (method === "eth_getCode") {
      result = "0x6080604052";
    } else if (method === "eth_getStorageAt") {
      result = "0x0000000000000000000000000000000000000000000000000000000000000000";
    } else if (method === "eth_feeHistory") {
      result = {
        oldestBlock: "0x1000000",
        baseFeePerGas: ["0x3b9aca00", "0x3b9aca00", "0x3b9aca00", "0x3b9aca00", "0x3b9aca00"],
        gasUsedRatio: [0.3, 0.3, 0.3, 0.3],
        reward: [["0x5f5e100", "0x5f5e100", "0x5f5e100", "0x5f5e100", "0x5f5e100"]]
      };
    } else if (method === "eth_maxPriorityFeePerGas") {
      result = "0x5f5e100";
    } else if (method === "eth_gasPrice") {
      result = "0x4190ab00";
    } else if (method === "eth_call") {
      result = "0x0000000000000000000000000000000000000000000000000000000000000001";
    } else if (method === "eth_estimateGas") {
      result = "0x5208";
    }

    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
}

test("stateless HMAC-SHA256 token issuer & constant-time verifier validate claims, expiry, tampering, and missing secret", async () => {
  assert.equal(constantTimeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(constantTimeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(constantTimeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);

  const nowMs = 1_800_000_000_000;
  const unconfigured = await issueApiToken(
    { plan: "starter", invoiceId: "inv_0123456789abcdef01234567", payerAddress: VALID_KYB.payerAddress, nowMs },
    ""
  );
  assert.equal(unconfigured, null);

  const issued = await issueApiToken(
    {
      plan: "growth",
      invoiceId: "inv_0123456789abcdef01234567",
      payerAddress: VALID_KYB.payerAddress,
      kybStatus: "VERIFIED",
      nowMs
    },
    TEST_SECRET
  );
  assert.ok(issued);
  assert.ok(issued.token.startsWith(TOKEN_PREFIX));
  assert.equal(issued.claims.exp - issued.claims.iat, 30 * 24 * 60 * 60);

  const verified = await verifyApiToken(issued.token, TEST_SECRET, { nowMs: nowMs + 60_000 });
  assert.equal(verified.ok, true);
  assert.equal(verified.claims.plan, "growth");
  assert.equal(verified.claims.invoiceId, "inv_0123456789abcdef01234567");
  assert.equal(verified.claims.payerAddress, VALID_KYB.payerAddress);

  // Tampered payload rejected
  const [prefixAndPayload, sig] = issued.token.split(".");
  const tampered = `${prefixAndPayload.slice(0, -1)}${prefixAndPayload.endsWith("a") ? "b" : "a"}.${sig}`;
  const tamperedRes = await verifyApiToken(tampered, TEST_SECRET, { nowMs });
  assert.equal(tamperedRes.ok, false);
  assert.equal(tamperedRes.reason, "INVALID_TOKEN_SIGNATURE");

  // Wrong secret rejected
  const wrongSecretRes = await verifyApiToken(issued.token, "different-secret", { nowMs });
  assert.equal(wrongSecretRes.ok, false);
  assert.equal(wrongSecretRes.reason, "INVALID_TOKEN_SIGNATURE");

  // Missing secret Fail-Closed
  const noSecretRes = await verifyApiToken(issued.token, "", { nowMs });
  assert.equal(noSecretRes.ok, false);
  assert.equal(noSecretRes.reason, "TOKEN_SECRET_NOT_CONFIGURED");

  // Expired after 30 days rejected
  const expiredRes = await verifyApiToken(issued.token, TEST_SECRET, { nowMs: nowMs + 31 * 24 * 60 * 60 * 1000 });
  assert.equal(expiredRes.ok, false);
  assert.equal(expiredRes.reason, "TOKEN_EXPIRED");

  // Static key auth & rejection
  const staticOk = await authenticateApiKeyHeader("b2b_static_key", {
    tokenSecret: TEST_SECRET,
    staticKeys: new Set(["b2b_static_key"])
  });
  assert.equal(staticOk.ok, true);
  assert.equal(staticOk.method, "static-key");
});

test("Portal KYB settlement issues stateless ve_live_... token usable across /aegis/*, /gaspulse/*, /auditpulse/*, and fresh Worker isolate", async () => {
  const txHash = "0x" + "1".repeat(64);
  const rpcFetch = makeSuiteRpcFetch({
    receiptsByTx: {
      [txHash]: makeUsdcReceipt({ units: 49000000n })
    }
  });

  const worker1 = createWorkerHandler({ fetchImpl: rpcFetch });
  const env = { VE_TOKEN_SECRET: TEST_SECRET };

  // Step 1: KYB checkout issues invoice (no apiKey yet)
  const step1Res = await worker1.fetch(
    new Request("https://gateway.venture-engine.workers.dev/v1/kyb-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_KYB)
    }),
    env
  );
  assert.equal(step1Res.status, 200);
  const step1 = await step1Res.json();
  assert.equal(step1.status, "INVOICE_ISSUED");
  assert.equal(step1.apiKey, undefined);

  // Step 2: /v1/verify-invoice confirms Base USDC and attaches stateless ve_live_... apiKey
  const step2Res = await worker1.fetch(
    new Request("https://gateway.venture-engine.workers.dev/v1/verify-invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoiceId: step1.invoice.invoiceId, txHash })
    }),
    env
  );
  assert.equal(step2Res.status, 200);
  const step2 = await step2Res.json();
  assert.equal(step2.status, "PAID_AND_VERIFIED");
  assert.ok(typeof step2.apiKey === "string" && step2.apiKey.startsWith(TOKEN_PREFIX));
  assert.ok(step2.tokenExpiresAt);

  // Use the issued token on a BRAND-NEW Worker isolate (proving stateless verification)
  const worker2 = createWorkerHandler({ fetchImpl: rpcFetch });

  // Unauthenticated calls return 402
  const aegis402 = await worker2.fetch(
    new Request("https://gateway.venture-engine.workers.dev/aegis/v1/screen?address=0x2222222222222222222222222222222222222222"),
    env
  );
  assert.equal(aegis402.status, 402);

  // Invalid ve_live_ token returns 401 Fail-Closed
  const badAuthRes = await worker2.fetch(
    new Request("https://gateway.venture-engine.workers.dev/gaspulse/v1/gas?chain=base", {
      headers: { "X-Api-Key": "ve_live_tampered.invalid" }
    }),
    env
  );
  assert.equal(badAuthRes.status, 401);

  // Authorized /aegis/v1/screen (prefix stripped)
  const aegis200 = await worker2.fetch(
    new Request("https://gateway.venture-engine.workers.dev/aegis/v1/screen?address=0x8589427373d6d84e98730d7795d8f6f8731fda16&chain=base", {
      headers: { "X-Api-Key": step2.apiKey }
    }),
    env
  );
  assert.equal(aegis200.status, 200);
  const aegisBody = await aegis200.json();
  assert.equal(aegisBody.report.verdict, "BLOCK");

  // Authorized /gaspulse/v1/gas & /gaspulse/v1/simulate
  const gas200 = await worker2.fetch(
    new Request("https://gateway.venture-engine.workers.dev/gaspulse/v1/gas?chain=base", {
      headers: { "X-Api-Key": step2.apiKey }
    }),
    env
  );
  assert.equal(gas200.status, 200);
  const gasBody = await gas200.json();
  assert.equal(gasBody.gas.chain, "base");
  assert.equal(gasBody.auth.method, "api-key");

  const sim200 = await worker2.fetch(
    new Request("https://gateway.venture-engine.workers.dev/gaspulse/v1/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": step2.apiKey },
      body: JSON.stringify({
        chain: "base",
        from: VALID_KYB.payerAddress,
        to: "0x2222222222222222222222222222222222222222",
        data: "0x"
      })
    }),
    env
  );
  assert.equal(sim200.status, 200);
  const simBody = await sim200.json();
  assert.equal(simBody.simulation.willRevert, false);

  // Authorized /auditpulse/v1/inspect & /auditpulse/v1/diff
  const inspect200 = await worker2.fetch(
    new Request("https://gateway.venture-engine.workers.dev/auditpulse/v1/inspect?address=0x2222222222222222222222222222222222222222&chain=base", {
      headers: { "X-Api-Key": step2.apiKey }
    }),
    env
  );
  assert.equal(inspect200.status, 200);
  const inspectBody = await inspect200.json();
  assert.equal(inspectBody.report.chain, "base");

  const diff200 = await worker2.fetch(
    new Request("https://gateway.venture-engine.workers.dev/auditpulse/v1/diff", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": step2.apiKey },
      body: JSON.stringify({
        previous: inspectBody.report,
        current: inspectBody.report
      })
    }),
    env
  );
  assert.equal(diff200.status, 200);
  const diffBody = await diff200.json();
  assert.equal(diffBody.diff.alertTriggered, false);
  assert.equal(diffBody.diff.changes.length, 0);
});

test("Gateway mounts Portal routes, sub-app /health routes, and x402 replay protection across mounts", async () => {
  const txPay = "0x" + "2".repeat(64);
  const rpcFetch = makeSuiteRpcFetch({
    receiptsByTx: {
      [txPay]: makeUsdcReceipt({ units: 10000n })
    }
  });
  const gateway = createGatewayHandler({ fetchImpl: rpcFetch, tokenSecret: TEST_SECRET });

  const portalHealth = await (await gateway(new Request("https://gateway.workers.dev/health"))).json();
  assert.equal(portalHealth.service, "venture-engine-portal");
  assert.equal(portalHealth.treasury, TREASURY_ADDRESS);

  const aegisHealth = await (await gateway(new Request("https://gateway.workers.dev/aegis/health"))).json();
  assert.equal(aegisHealth.service, "aegisgate");

  const gasHealth = await (await gateway(new Request("https://gateway.workers.dev/gaspulse/health"))).json();
  assert.equal(gasHealth.service, "gaspulse");

  const auditHealth = await (await gateway(new Request("https://gateway.workers.dev/auditpulse/health"))).json();
  assert.equal(auditHealth.service, "auditpulse");

  const x402Doc = await (await gateway(new Request("https://gateway.workers.dev/.well-known/x402.json"))).json();
  assert.equal(x402Doc.treasury.address, TREASURY_ADDRESS);

  // Pay via X-Payment-Tx on /aegis/v1/screen -> 200
  const paidRes = await gateway(
    new Request("https://gateway.workers.dev/aegis/v1/screen?address=0x2222222222222222222222222222222222222222", {
      headers: { "X-Payment-Tx": txPay }
    })
  );
  assert.equal(paidRes.status, 200);

  // Replay the same txHash on /gaspulse/v1/gas -> blocked (402 TX_ALREADY_CONSUMED)
  const crossReplay = await gateway(
    new Request("https://gateway.workers.dev/gaspulse/v1/gas?chain=base", {
      headers: { "X-Payment-Tx": txPay }
    })
  );
  assert.equal(crossReplay.status, 402);
  assert.equal((await crossReplay.json()).paymentError, "TX_ALREADY_CONSUMED");
});

test("Worker respects env.ETH_RPC_URL/BASE_RPC_URL on /aegis/* and isolates ASSETS from /aegis/", async () => {
  const calledRpcUrls = [];
  const baseRpcFetch = makeSuiteRpcFetch({
    receiptsByTx: {
      ["0x" + "6".repeat(64)]: makeUsdcReceipt({ units: 49000000n })
    }
  });
  const trackingFetch = async (url, init) => {
    calledRpcUrls.push(url);
    return baseRpcFetch(url, init);
  };

  const workerApp = createWorkerHandler({
    fetchImpl: trackingFetch,
    rpcOverrides: { base: ["https://custom-base-array.example/rpc"] }
  });
  const env = {
    VE_TOKEN_SECRET: TEST_SECRET,
    ETH_RPC_URL: "https://custom-eth.example/rpc",
    VE_STATIC_API_KEYS: "static_eth_test",
    ASSETS: {
      async fetch(req) {
        if (new URL(req.url).pathname === "/") {
          return new Response("<html><title>PORTAL_ASSET_HTML</title></html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
        return new Response("Not Found", { status: 404 });
      }
    }
  };

  // GET / serves Portal asset from env.ASSETS, while GET /aegis/ serves AegisGate landing (not Portal ASSETS)
  const portalHome = await workerApp.fetch(new Request("https://gateway.workers.dev/"), env);
  assert.equal(portalHome.status, 200);
  assert.match(await portalHome.text(), /PORTAL_ASSET_HTML/);

  const aegisHome = await workerApp.fetch(new Request("https://gateway.workers.dev/aegis/"), env);
  assert.equal(aegisHome.status, 200);
  const aegisHtml = await aegisHome.text();
  assert.match(aegisHtml, /AegisGate API/);
  assert.equal(aegisHtml.includes("PORTAL_ASSET_HTML"), false);

  // /aegis/v1/screen?chain=ethereum routes to env.ETH_RPC_URL (never cloudflare-eth.com)
  const ethScreen = await workerApp.fetch(
    new Request("https://gateway.workers.dev/aegis/v1/screen?address=0x2222222222222222222222222222222222222222&chain=ethereum", {
      headers: { "X-Api-Key": "static_eth_test" }
    }),
    env
  );
  assert.equal(ethScreen.status, 200);
  assert.ok(calledRpcUrls.some((u) => u === "https://custom-eth.example/rpc"));
  assert.equal(calledRpcUrls.includes("https://ethereum-rpc.publicnode.com"), false);
  assert.equal(calledRpcUrls.includes("https://cloudflare-eth.com"), false);

  // Portal array rpcOverrides.base normalizes cleanly to first element
  const verifyRes = await workerApp.fetch(
    new Request("https://gateway.workers.dev/v1/verify-invoice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "starter", txHash: "0x" + "6".repeat(64) })
    }),
    env
  );
  assert.equal(verifyRes.status, 200);
  assert.ok(calledRpcUrls.includes("https://custom-base-array.example/rpc"));
});

test("GET /v1/demo runs strictly locked canonical checks (aegis, gaspulse, auditpulse) and rejects arbitrary checks", async () => {
  const gateway = createGatewayHandler({ fetchImpl: makeSuiteRpcFetch() });

  const aegisRes = await gateway(
    new Request("https://gateway.workers.dev/v1/demo?check=aegis&address=0x2222222222222222222222222222222222222222&chain=arbitrum")
  );
  assert.equal(aegisRes.status, 200);
  const aegisBody = await aegisRes.json();
  assert.equal(aegisBody.ok, true);
  assert.equal(aegisBody.demo, true);
  assert.equal(aegisBody.check, "aegis");
  assert.equal(aegisBody.result.address, "0x8589427373d6d84e98730d7795d8f6f8731fda16");
  assert.equal(aegisBody.result.chain, "ethereum");
  assert.equal(aegisBody.result.verdict, "BLOCK");

  const gasRes = await gateway(new Request("https://gateway.workers.dev/v1/demo?check=gaspulse"));
  assert.equal(gasRes.status, 200);
  const gasBody = await gasRes.json();
  assert.equal(gasBody.ok, true);
  assert.equal(gasBody.check, "gaspulse");
  assert.equal(gasBody.result.chain, "base");

  const auditRes = await gateway(new Request("https://gateway.workers.dev/v1/demo?check=auditpulse"));
  assert.equal(auditRes.status, 200);
  const auditBody = await auditRes.json();
  assert.equal(auditBody.ok, true);
  assert.equal(auditBody.check, "auditpulse");
  assert.equal(auditBody.result.address, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(auditBody.result.chain, "base");

  const invalidRes = await gateway(new Request("https://gateway.workers.dev/v1/demo?check=custom"));
  assert.equal(invalidRes.status, 400);
  assert.equal((await invalidRes.json()).code, "INVALID_DEMO_CHECK");

  const missingRes = await gateway(new Request("https://gateway.workers.dev/v1/demo"));
  assert.equal(missingRes.status, 400);
  assert.equal((await missingRes.json()).code, "INVALID_DEMO_CHECK");

  const methodRes = await gateway(new Request("https://gateway.workers.dev/v1/demo?check=aegis", { method: "POST" }));
  assert.equal(methodRes.status, 405);
});

test("Remote HTTP POST /mcp allows free initialize & tools/list (all 7 tools) and enforces X-Api-Key or X-Payment-Tx on tools/call", async () => {
  const txInspect = "0x" + "3".repeat(64);
  const txVerify = "0x" + "4".repeat(64);
  const rpcFetch = makeSuiteRpcFetch({
    receiptsByTx: {
      [txInspect]: makeUsdcReceipt({ units: 20000n }),
      [txVerify]: makeUsdcReceipt({ units: 20000n })
    }
  });

  const gateway = createGatewayHandler({
    fetchImpl: rpcFetch,
    tokenSecret: TEST_SECRET,
    apiKeys: new Set(["static_mcp_key"])
  });

  const issued = await issueApiToken(
    { plan: "enterprise", invoiceId: "inv_abcdef0123456789abcdef01", payerAddress: VALID_KYB.payerAddress },
    TEST_SECRET
  );

  // 1. Free initialize
  const initRes = await gateway(
    new Request("https://gateway.workers.dev/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })
    })
  );
  assert.equal(initRes.status, 200);
  const initBody = await initRes.json();
  assert.equal(initBody.result.protocolVersion, "2024-11-05");

  // 2. Free tools/list exposes all 7 tools
  const listRes = await gateway(
    new Request("https://gateway.workers.dev/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    })
  );
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  const toolNames = listBody.result.tools.map((t) => t.name);
  assert.equal(ALL_MCP_TOOLS.length, 8);
  assert.deepEqual(toolNames, [
    "screen_evm_address",
    "estimate_gas",
    "simulate_transaction",
    "check_rpc_health",
    "inspect_contract_invariants",
    "diff_contract_snapshots",
    "verify_x402_payment",
    "batch_screen_evm_addresses"
  ]);

  // 3. Unauthenticated tools/call -> 402 x402 challenge
  const unauthCall = await gateway(
    new Request("https://gateway.workers.dev/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "estimate_gas", arguments: { chain: "base" } }
      })
    })
  );
  assert.equal(unauthCall.status, 402);
  const unauthBody = await unauthCall.json();
  assert.equal(unauthBody.protocol, "x402");
  assert.equal(unauthBody.accepts[0].payTo, TREASURY_ADDRESS);

  // 4. Invalid X-Api-Key on tools/call -> 401
  const badKeyCall = await gateway(
    new Request("https://gateway.workers.dev/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "ve_live_bad.sig" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "estimate_gas", arguments: { chain: "base" } }
      })
    })
  );
  assert.equal(badKeyCall.status, 401);

  // 5. X-Payment-Tx pays for inspect_contract_invariants ($0.02 = 20000 units)
  const paidInspect = await gateway(
    new Request("https://gateway.workers.dev/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Payment-Tx": txInspect },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "inspect_contract_invariants",
          arguments: { address: "0x2222222222222222222222222222222222222222", chain: "base" }
        }
      })
    })
  );
  assert.equal(paidInspect.status, 200);
  const inspectData = JSON.parse((await paidInspect.json()).result.content[0].text);
  assert.equal(inspectData.chain, "base");

  // 6. Execute remaining tools with HMAC ve_live_ token and static key
  const callTool = async (name, args, apiKey = issued.token) => {
    const res = await gateway(
      new Request("https://gateway.workers.dev/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } })
      })
    );
    assert.equal(res.status, 200);
    return res.json();
  };

  const screenRes = await callTool("screen_evm_address", {
    address: "0x2222222222222222222222222222222222222222",
    chain: "base"
  });
  assert.equal(JSON.parse(screenRes.result.content[0].text).verdict, "ALLOW");

  const gasRes = await callTool("estimate_gas", { chain: "base" }, "static_mcp_key");
  assert.equal(JSON.parse(gasRes.result.content[0].text).chain, "base");

  const simRes = await callTool("simulate_transaction", {
    chain: "base",
    from: VALID_KYB.payerAddress,
    to: "0x2222222222222222222222222222222222222222"
  });
  assert.equal(JSON.parse(simRes.result.content[0].text).willRevert, false);

  const rpcHealthRes = await callTool("check_rpc_health", { chain: "base" });
  const rpcHealthJson = JSON.parse(rpcHealthRes.result.content[0].text);
  assert.equal(rpcHealthJson.chainId, 8453);
  assert.ok(rpcHealthJson.healthyCount >= 1);

  const diffRes = await callTool("diff_contract_snapshots", {
    previous: inspectData,
    current: inspectData,
    format: "slack"
  });
  const diffJson = JSON.parse(diffRes.result.content[0].text);
  assert.equal(diffJson.diff.alertTriggered, false);
  assert.equal(diffJson.diff.changes.length, 0);

  const verifyToolRes = await callTool("verify_x402_payment", { txHash: txVerify, minAmountUsdcUnits: "20000" });
  assert.equal(JSON.parse(verifyToolRes.result.content[0].text).ok, true);
});

test("Node HTTP gateway server handles full KYB -> token -> product API -> MCP flow", async () => {
  const txHash = "0x" + "5".repeat(64);
  const server = createGatewayServer({
    fetchImpl: makeSuiteRpcFetch({
      receiptsByTx: { [txHash]: makeUsdcReceipt({ units: 199000000n }) }
    }),
    tokenSecret: TEST_SECRET
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const checkoutRes = await fetch(`${baseUrl}/v1/kyb-checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...VALID_KYB, plan: "growth", txHash })
    });
    assert.equal(checkoutRes.status, 200);
    const checkout = await checkoutRes.json();
    assert.equal(checkout.status, "PAID_AND_VERIFIED");
    assert.ok(checkout.apiKey.startsWith(TOKEN_PREFIX));

    const gasRes = await fetch(`${baseUrl}/gaspulse/v1/gas?chain=base`, {
      headers: { "X-Api-Key": checkout.apiKey }
    });
    assert.equal(gasRes.status, 200);
    assert.equal((await gasRes.json()).gas.chain, "base");

    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": checkout.apiKey },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "estimate_gas", arguments: { chain: "base" } }
      })
    });
    assert.equal(mcpRes.status, 200);
    const mcpJson = await mcpRes.json();
    assert.equal(JSON.parse(mcpJson.result.content[0].text).chain, "base");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Default worker export + gateway manifests preserve zero node:* imports in edge code and zero PII/secrets", async () => {
  const healthRes = await worker.fetch(new Request("https://gateway.venture-engine.workers.dev/health"));
  assert.equal(healthRes.status, 200);
  assert.equal((await healthRes.json()).treasury, TREASURY_ADDRESS);

  const glamaRes = await worker.fetch(new Request("https://gateway.venture-engine.workers.dev/mcp/.well-known/glama.json"));
  assert.equal(glamaRes.status, 200);
  const glamaJson = await glamaRes.json();
  assert.equal(glamaJson.$schema, "https://glama.ai/mcp/schemas/connector.json");
  assert.equal(glamaJson.claim, "glama_claim_WbbIub2HjCct5cGsxJaj9aU4wQvRU3lL");

  const edgeModules = ["src/auth_tokens.mjs", "src/mcp_http.mjs", "src/gateway.mjs", "src/worker.mjs"];
  for (const rel of edgeModules) {
    const content = readGatewayFile(rel);
    assert.equal(/from\s+["']node:/i.test(content), false, `Forbidden node:* import in ${rel}`);
  }

  const wrangler = readGatewayFile("wrangler.toml");
  assert.match(wrangler, /^name\s*=/m);
  assert.match(wrangler, /^main\s*=\s*"src\/worker\.mjs"/m);
  assert.match(wrangler, /^compatibility_date\s*=/m);
  assert.ok(wrangler.includes(TREASURY_ADDRESS));

  const filesToAudit = [
    "package.json",
    "wrangler.toml",
    "README.md",
    "src/auth_tokens.mjs",
    "src/mcp_http.mjs",
    "src/gateway.mjs",
    "src/worker.mjs",
    "src/server.mjs",
    "tests/gateway.test.mjs"
  ];

  const userPathPattern = new RegExp(["[A-Za-z]:", "Users", ""].join("\\\\"), "i");
  const privKeyAssignPattern = new RegExp(["PRIVATE", "KEY\\s*="].join("_"));
  const mnemonicAssignPattern = new RegExp(["MNEMONIC", "\\s*="].join(""));
  const seedAssignPattern = new RegExp(["SEED", "PHRASE\\s*="].join("_"));
  const signingPattern = new RegExp(["eth_send", "Transaction|sign", "Transaction"].join(""));

  for (const rel of filesToAudit) {
    const content = readGatewayFile(rel);
    assert.equal(userPathPattern.test(content), false, `Local user path leaked in ${rel}`);
    assert.equal(privKeyAssignPattern.test(content), false, `Private key pattern found in ${rel}`);
    assert.equal(mnemonicAssignPattern.test(content), false, `Mnemonic pattern found in ${rel}`);
    assert.equal(seedAssignPattern.test(content), false, `Seed phrase pattern found in ${rel}`);
    assert.equal(signingPattern.test(content), false, `Signing call pattern found in ${rel}`);
  }
});

test("GET /v1/badge returns embeddable SVG risk badge and validates parameters", async () => {
  const handler = createGatewayHandler({
    fetchImpl: makeSuiteRpcFetch(),
    tokenSecret: TEST_SECRET
  });

  const okRes = await handler(
    new Request("https://gateway.venture-engine.workers.dev/v1/badge?address=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&chain=base")
  );
  assert.equal(okRes.status, 200);
  assert.match(okRes.headers.get("content-type") || "", /image\/svg\+xml/);
  const svg = await okRes.text();
  assert.ok(svg.includes("<svg"));
  assert.ok(svg.includes("AegisGate (base)"));
  assert.ok(svg.includes("ALLOW (0/100)"));

  const ofacRes = await handler(
    new Request("https://gateway.venture-engine.workers.dev/v1/badge?address=0x8589427373d6d84e98730d7795d8f6f8731fda16&chain=ethereum")
  );
  assert.equal(ofacRes.status, 200);
  const ofacSvg = await ofacRes.text();
  assert.ok(ofacSvg.includes("BLOCK (100/100)"));

  const badRes = await handler(
    new Request("https://gateway.venture-engine.workers.dev/v1/badge?address=not-an-address")
  );
  assert.equal(badRes.status, 400);
});

test("POST /aegis/v1/screen/batch and MCP batch_screen_evm_addresses require auth and screen up to 20 addresses", async () => {
  const handler = createGatewayHandler({
    fetchImpl: makeSuiteRpcFetch(),
    tokenSecret: TEST_SECRET,
    apiKeys: new Set(["ve_test_batch_key"])
  });

  const unauthRes = await handler(
    new Request("https://gateway.venture-engine.workers.dev/aegis/v1/screen/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"] })
    })
  );
  assert.equal(unauthRes.status, 402);

  const authRes = await handler(
    new Request("https://gateway.venture-engine.workers.dev/aegis/v1/screen/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "ve_test_batch_key" },
      body: JSON.stringify({
        chain: "ethereum",
        addresses: [
          "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          "0x8589427373d6d84e98730d7795d8f6f8731fda16"
        ]
      })
    })
  );
  assert.equal(authRes.status, 200);
  const data = await authRes.json();
  assert.equal(data.total, 2);
  assert.equal(data.blockedCount, 1);
  assert.equal(data.allowCount, 1);

  const mcpRes = await handler(
    new Request("https://gateway.venture-engine.workers.dev/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "ve_test_batch_key" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 77,
        method: "tools/call",
        params: {
          name: "batch_screen_evm_addresses",
          arguments: {
            chain: "ethereum",
            addresses: [
              "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
              "0x8589427373d6d84e98730d7795d8f6f8731fda16"
            ]
          }
        }
      })
    })
  );
  assert.equal(mcpRes.status, 200);
  const mcpJson = await mcpRes.json();
  const parsed = JSON.parse(mcpJson.result.content[0].text);
  assert.equal(parsed.total, 2);
  assert.equal(parsed.blockedCount, 1);
});

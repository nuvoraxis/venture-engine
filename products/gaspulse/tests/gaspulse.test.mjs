import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CANONICAL_CHAINS, TREASURY_ADDRESS, formatUnits, toRpcQuantityHex } from "../src/chains.mjs";
import { RpcPool, RpcPoolError } from "../src/rpc_pool.mjs";
import { decodeRevertData, estimateGasMetrics, simulateTransaction } from "../src/gas_pulse.mjs";
import {
  BASE_USDC_ADDRESS,
  ERC20_TRANSFER_TOPIC,
  authorizeRequest,
  createReplayStore,
  verifyBaseUsdcPayment
} from "../src/x402.mjs";
import { createGasPulseServer } from "../src/server.mjs";
import workerDefault, { createWorkerHandler } from "../src/worker.mjs";
import { createMcpDispatcher } from "../src/mcp_server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);

const SAMPLE_FROM = "0x1111111111111111111111111111111111111111";
const SAMPLE_TO = "0x2222222222222222222222222222222222222222";
const SANCTIONED_MIXER = "0x8589427373d6d84e98730d7795d8f6f8731fda16";

function encodeAbiErrorString(message) {
  const utf8Hex = Buffer.from(message, "utf8").toString("hex");
  const lenHex = message.length.toString(16).padStart(64, "0");
  const paddedData = utf8Hex.padEnd(Math.ceil(utf8Hex.length / 64) * 64 || 64, "0");
  return "0x08c379a0" + "0000000000000000000000000000000000000000000000000000000000000020" + lenHex + paddedData;
}

function makeFeeHistoryMock(overrides = {}) {
  return {
    oldestBlock: overrides.oldestBlock ?? "0x1000",
    baseFeePerGas: overrides.baseFeePerGas ?? ["0x3b9aca00", "0x3b9aca00", "0x4190ab00", "0x47868c00"], // ~1 -> 1.2 Gwei
    gasUsedRatio: overrides.gasUsedRatio ?? [0.42, 0.55, 0.68],
    reward: overrides.reward ?? [
      ["0x5f5e100", "0xbebc200", "0x17d78400", "0x2faf0800", "0x5f5e1000"],
      ["0x5f5e100", "0xbebc200", "0x17d78400", "0x2faf0800", "0x5f5e1000"],
      ["0x5f5e100", "0xbebc200", "0x17d78400", "0x2faf0800", "0x5f5e1000"]
    ]
  };
}

function makeMockRpcFetch({ perUrlHandler, overrides = {} } = {}) {
  return async (url, init) => {
    assert.equal(typeof url, "string");
    assert.ok(url.startsWith("https://"), `Expected https:// RPC URL, got: ${url}`);
    const body = JSON.parse(init.body);
    if (perUrlHandler) {
      const custom = await perUrlHandler(url, body, init);
      if (custom) return custom;
    }

    const { method } = body;
    let result = "0x0";
    if (method === "eth_chainId") {
      if (url.includes("arb")) result = toRpcQuantityHex(CANONICAL_CHAINS.arbitrum.chainId);
      else if (url.includes("eth") || url.includes("cloudflare")) result = toRpcQuantityHex(CANONICAL_CHAINS.ethereum.chainId);
      else result = toRpcQuantityHex(CANONICAL_CHAINS.base.chainId);
    }
    if (method === "eth_blockNumber") result = overrides.blockNumber ?? "0x1000";
    if (method === "eth_feeHistory") result = overrides.feeHistory ?? makeFeeHistoryMock();
    if (method === "eth_maxPriorityFeePerGas") result = overrides.maxPriorityFee ?? "0x17d78400";
    if (method === "eth_gasPrice") result = overrides.gasPrice ?? "0x59682f00";
    if (method === "eth_call") {
      if (overrides.callError) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: overrides.callError }), { status: 200 });
      }
      result = overrides.callResult ?? "0x0000000000000000000000000000000000000000000000000000000000000001";
    }
    if (method === "eth_estimateGas") {
      if (overrides.estimateError) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: overrides.estimateError }), { status: 200 });
      }
      result = overrides.estimateGas ?? "0x5208"; // 21000
    }
    if (method === "eth_getBalance") result = overrides.balance ?? "0xde0b6b3a7640000"; // 1 ETH
    if (method === "eth_getTransactionReceipt") result = overrides.receipt ?? null;

    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
}

// ---------------------------------------------------------------------------
// 1. Multi-chain RPC Latency, Health & Circuit-Breaker Failover Tests
// ---------------------------------------------------------------------------

test("RpcPool fails over on HTTP 503, trips circuit breaker, and skips open endpoint", async () => {
  const callsByUrl = new Map();
  let now = 1_000_000;

  const pool = new RpcPool({
    rpcOverrides: {
      base: ["https://rpc1.base.test", "https://rpc2.base.test"]
    },
    failureThreshold: 2,
    cooldownMs: 30_000,
    nowFn: () => now,
    fetchImpl: async (url, init) => {
      callsByUrl.set(url, (callsByUrl.get(url) || 0) + 1);
      if (url === "https://rpc1.base.test") {
        return new Response("upstream overloaded", { status: 503 });
      }
      const body = JSON.parse(init.body);
      const result = body.method === "eth_chainId" ? "0x2105" : "0x100";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    }
  });

  // Call 1: rpc1 fails once (degraded) -> fails over to rpc2
  const r1 = await pool.callWithMeta("base", "eth_blockNumber", []);
  assert.equal(r1.ok, true);
  assert.equal(r1.endpoint, "https://rpc2.base.test");
  assert.equal(r1.attempts.length, 2);
  assert.equal(pool.getHealthSnapshot("base").endpoints[0].status, "degraded");

  // Probe fails rpc1 a 2nd time -> circuit opens
  await pool.probeChain("base");
  const snapOpen = pool.getHealthSnapshot("base");
  assert.equal(snapOpen.endpoints[0].status, "open");
  assert.equal(snapOpen.endpoints[1].status, "healthy");
  assert.equal(snapOpen.activeEndpoint, "https://rpc2.base.test");

  const rpc1CallsBeforeOpenTraffic = callsByUrl.get("https://rpc1.base.test");

  // Call 2: rpc1 circuit is open -> routed straight to rpc2 (0 calls to rpc1)
  const r2 = await pool.callWithMeta("base", "eth_blockNumber", []);
  assert.equal(r2.attempts.length, 1);
  assert.equal(r2.endpoint, "https://rpc2.base.test");
  assert.equal(callsByUrl.get("https://rpc1.base.test"), rpc1CallsBeforeOpenTraffic);

  // After cooldown expires, rpc1 can be retried again as half-open
  now += 31_000;
  const snapAfterCooldown = pool.getHealthSnapshot("base");
  assert.equal(snapAfterCooldown.endpoints[0].circuitOpenUntil, null);
});

test("RpcPool probeChain selects lowest-latency endpoint and flags block lag and chainId mismatch", async () => {
  let fakeTime = 10_000;
  const pool = new RpcPool({
    rpcOverrides: {
      base: ["https://slow.base.test", "https://fast.base.test", "https://wrongchain.base.test"]
    },
    maxBlockLag: 3,
    nowFn: () => fakeTime,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url === "https://slow.base.test") fakeTime += 80;
      else if (url === "https://fast.base.test") fakeTime += 5;
      else fakeTime += 10;

      if (body.method === "eth_chainId") {
        const cid = url.includes("wrongchain") ? "0x1" : "0x2105"; // 8453
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: cid }), { status: 200 });
      }
      if (body.method === "eth_blockNumber") {
        const blk = url.includes("slow") ? "0x64" : "0x78"; // 100 vs 120 (lag 20 > maxBlockLag 3)
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: blk }), { status: 200 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }), { status: 200 });
    }
  });

  const health = await pool.probeChain("base");
  assert.equal(health.activeEndpoint, "https://fast.base.test");
  assert.equal(health.highestBlockNumber, 120);

  const slowEp = health.endpoints.find((e) => e.endpoint === "https://slow.base.test");
  const fastEp = health.endpoints.find((e) => e.endpoint === "https://fast.base.test");
  const badEp = health.endpoints.find((e) => e.endpoint === "https://wrongchain.base.test");

  assert.equal(fastEp.status, "healthy");
  assert.equal(slowEp.lagBlocks, 20);
  assert.equal(slowEp.status, "degraded");
  assert.equal(badEp.status, "degraded");
  assert.match(badEp.lastError, /Chain ID mismatch/);
});

test("RpcPool treats deterministic EVM revert as RPC success without failing over", async () => {
  let calls = 0;
  const pool = new RpcPool({
    rpcOverrides: { base: ["https://rpc1.base.test", "https://rpc2.base.test"] },
    fetchImpl: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: 3, message: "execution reverted", data: encodeAbiErrorString("UNAUTHORIZED") }
        }),
        { status: 200 }
      );
    }
  });

  const res = await pool.callWithMeta("base", "eth_call", [{ to: SAMPLE_TO }, "latest"]);
  assert.equal(res.ok, false);
  assert.equal(res.reverted, true);
  assert.equal(calls, 1);
  assert.equal(pool.getHealthSnapshot("base").endpoints[0].status, "healthy");
});

test("RpcPool throws RpcPoolError when all endpoints fail", async () => {
  const pool = new RpcPool({
    rpcOverrides: { arbitrum: ["https://arb1.test", "https://arb2.test"] },
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    }
  });

  await assert.rejects(
    () => pool.callWithMeta("arbitrum", "eth_blockNumber", []),
    (err) => err instanceof RpcPoolError && err.attempts.length === 2
  );
});

// ---------------------------------------------------------------------------
// 2. EIP-1559 Gas Estimator & Revert Decoder Tests
// ---------------------------------------------------------------------------

test("estimateGasMetrics computes EIP-1559 tiers, trend, and congestion across chains", async () => {
  const pool = new RpcPool({
    fetchImpl: makeMockRpcFetch({
      overrides: {
        feeHistory: makeFeeHistoryMock({
          baseFeePerGas: ["0x3b9aca00", "0x59682f00", "0x77359400", "0x9502f900"], // rising 1 -> 2.5 gwei
          gasUsedRatio: [0.75, 0.82, 0.85]
        })
      }
    })
  });

  const report = await estimateGasMetrics("ethereum", pool);
  assert.equal(report.chain, "ethereum");
  assert.equal(report.chainId, 1);
  assert.equal(report.baseFeeTrend, "rising");
  assert.equal(report.congestionLevel, "EXTREME");
  assert.equal(BigInt(report.tiers.urgent.maxFeePerGasWei) > BigInt(report.tiers.fast.maxFeePerGasWei), true);
  assert.equal(BigInt(report.tiers.fast.maxFeePerGasWei) > BigInt(report.tiers.standard.maxFeePerGasWei), true);
  assert.equal(BigInt(report.tiers.standard.maxFeePerGasWei) > BigInt(report.tiers.slow.maxFeePerGasWei), true);
});

test("estimateGasMetrics falls back cleanly when eth_feeHistory is unavailable", async () => {
  const pool = new RpcPool({
    rpcOverrides: { base: ["https://rpc1.base.test"] },
    fetchImpl: makeMockRpcFetch({
      perUrlHandler: async (_url, body) => {
        if (body.method === "eth_feeHistory") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unsupported" } }), {
            status: 200
          });
        }
        return null;
      },
      overrides: { gasPrice: "0x77359400", maxPriorityFee: "0x5f5e100" }
    })
  });

  const report = await estimateGasMetrics("base", pool);
  assert.equal(report.chain, "base");
  assert.equal(report.legacyGasPriceGwei, "2");
  assert.ok(Number(report.tiers.standard.maxFeePerGasGwei) > 0);
});

test("decodeRevertData decodes Solidity Error(string) and Panic(uint256)", () => {
  assert.equal(
    decodeRevertData({ code: 3, message: "execution reverted", data: encodeAbiErrorString("INSUFFICIENT_OUTPUT_AMOUNT") }),
    "INSUFFICIENT_OUTPUT_AMOUNT"
  );
  assert.equal(
    decodeRevertData({
      code: 3,
      message: "execution reverted",
      data: "0x4e487b710000000000000000000000000000000000000000000000000000000000000011"
    }),
    "Panic(0x11): Arithmetic overflow or underflow"
  );
  assert.equal(formatUnits(1_250_000_000n, 9, 4), "1.25");
});

// ---------------------------------------------------------------------------
// 3. Pre-Flight Simulation & Mempool Guard Tests
// ---------------------------------------------------------------------------

test("simulateTransaction returns PASS with 20% gas buffer for valid call", async () => {
  const pool = new RpcPool({
    fetchImpl: makeMockRpcFetch({ overrides: { estimateGas: "0x186a0" } }) // 100,000 gas
  });

  const sim = await simulateTransaction(
    {
      chain: "base",
      tx: { from: SAMPLE_FROM, to: SAMPLE_TO, data: "0x", value: "1000" }
    },
    pool
  );

  assert.equal(sim.verdict, "PASS");
  assert.equal(sim.willRevert, false);
  assert.equal(sim.estimatedGas, "100000");
  assert.equal(sim.recommendedGasLimit, "120000");
  assert.equal(sim.mempoolGuard.warnings.length, 0);
});

test("simulateTransaction detects REVERT and decodes revertReason", async () => {
  const pool = new RpcPool({
    fetchImpl: makeMockRpcFetch({
      overrides: {
        callError: { code: 3, message: "execution reverted", data: encodeAbiErrorString("SLIPPAGE_EXCEEDED") },
        estimateError: { code: -32000, message: "execution reverted" }
      }
    })
  });

  const sim = await simulateTransaction(
    { chain: "arbitrum", from: SAMPLE_FROM, to: SAMPLE_TO, data: "0xdeadbeef" },
    pool
  );

  assert.equal(sim.verdict, "REVERT");
  assert.equal(sim.willRevert, true);
  assert.equal(sim.revertReason, "SLIPPAGE_EXCEEDED");
  assert.equal(sim.mempoolGuard.riskLevel, "CRITICAL");
});

test("simulateTransaction emits Mempool Guard WARN for low maxFee, low balance, and Ethereum swap exposure", async () => {
  const pool = new RpcPool({
    fetchImpl: makeMockRpcFetch({
      overrides: {
        balance: "0x64", // 100 wei (insufficient for value + gas)
        estimateGas: "0x249f0" // 150,000 gas
      }
    })
  });

  const sim = await simulateTransaction(
    {
      chain: "ethereum",
      from: SAMPLE_FROM,
      to: SAMPLE_TO,
      data: "0x38ed1739" + "00".repeat(32), // swapExactTokensForTokens
      value: "1000",
      maxFeePerGas: "100" // below nextBaseFee (~1.2 gwei)
    },
    pool
  );

  assert.equal(sim.verdict, "WARN");
  assert.equal(sim.mempoolGuard.swapSelectorDetected, true);
  const codes = sim.mempoolGuard.warnings.map((w) => w.code);
  assert.ok(codes.includes("MAX_FEE_BELOW_NEXT_BASE_FEE"));
  assert.ok(codes.includes("INSUFFICIENT_NATIVE_BALANCE_FOR_VALUE_AND_GAS"));
  assert.ok(codes.includes("MEMPOOL_SANDWICH_EXPOSURE"));
});

test("simulateTransaction blocks OFAC/mixer address fail-closed before calling RPC", async () => {
  let rpcCalled = false;
  const pool = new RpcPool({
    fetchImpl: async () => {
      rpcCalled = true;
      return new Response("{}", { status: 200 });
    }
  });

  const sim = await simulateTransaction({ chain: "base", to: SANCTIONED_MIXER, data: "0x" }, pool);
  assert.equal(sim.blocked, true);
  assert.equal(sim.verdict, "BLOCK");
  assert.equal(sim.reason, "OFAC_MIXER_ADDRESS_BLOCKED");
  assert.equal(rpcCalled, false);
});

test("simulateTransaction rejects malformed inputs", async () => {
  const pool = new RpcPool({ fetchImpl: makeMockRpcFetch() });
  await assert.rejects(() => simulateTransaction({ chain: "solana", to: SAMPLE_TO }, pool), /Unsupported chain/);
  await assert.rejects(() => simulateTransaction({ chain: "base", to: "0x123" }, pool), /Invalid 'to' address/);
  await assert.rejects(() => simulateTransaction({ chain: "base", to: SAMPLE_TO, data: "0xabc" }, pool), /Invalid 'data'/);
  await assert.rejects(() => simulateTransaction({ chain: "base" }, pool), /requires a 'to' address/);
});

// ---------------------------------------------------------------------------
// 4. x402 Base USDC Verification & B2B KYC Auth Tests
// ---------------------------------------------------------------------------

test("verifyBaseUsdcPayment verifies valid receipt, blocks AML payer, and enforces replay cache", async () => {
  const txHash = "0x" + "b".repeat(64);
  const payerTopic = "0x" + "4".repeat(40).padStart(64, "0");
  const treasuryTopic = "0x" + TREASURY_ADDRESS.slice(2).padStart(64, "0");

  const validFetch = makeMockRpcFetch({
    overrides: {
      receipt: {
        status: "0x1",
        from: SAMPLE_FROM,
        logs: [
          {
            address: BASE_USDC_ADDRESS,
            topics: [ERC20_TRANSFER_TOPIC, payerTopic, treasuryTopic],
            data: "0x2710" // 10000 = $0.01 USDC
          }
        ]
      }
    }
  });

  const replayStore = createReplayStore(2);
  const first = await verifyBaseUsdcPayment(txHash, 10000n, replayStore, validFetch);
  assert.equal(first.ok, true);
  assert.equal(first.transferredUnits, "10000");

  const replay = await verifyBaseUsdcPayment(txHash, 10000n, replayStore, validFetch);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "TX_ALREADY_CONSUMED");

  // Replay store eviction at maxEntries=2
  replayStore.add("0x" + "c".repeat(64));
  replayStore.add("0x" + "d".repeat(64));
  assert.equal(replayStore.size, 2);

  // Sanctioned payer blocked
  const mixerTopic = "0x" + SANCTIONED_MIXER.slice(2).padStart(64, "0");
  const blockedFetch = makeMockRpcFetch({
    overrides: {
      receipt: {
        status: "0x1",
        logs: [
          {
            address: BASE_USDC_ADDRESS,
            topics: [ERC20_TRANSFER_TOPIC, mixerTopic, treasuryTopic],
            data: "0x2710"
          }
        ]
      }
    }
  });
  const blocked = await verifyBaseUsdcPayment("0x" + "e".repeat(64), 10000n, new Set(), blockedFetch);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "PAYER_BLOCKED_BY_AML");

  // Malformed log.data returns INVALID_TRANSFER_LOG_DATA cleanly without throwing
  const malformedFetch = makeMockRpcFetch({
    overrides: {
      receipt: {
        status: "0x1",
        logs: [
          {
            address: BASE_USDC_ADDRESS,
            topics: [ERC20_TRANSFER_TOPIC, payerTopic, treasuryTopic],
            data: "not-valid-hex"
          }
        ]
      }
    }
  });
  const malformed = await verifyBaseUsdcPayment("0x" + "1".repeat(64), 10000n, new Set(), malformedFetch);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, "INVALID_TRANSFER_LOG_DATA");

  // Standalone failover across CANONICAL_CHAINS.base.rpcs when primary Base RPC returns 503
  let attemptUrls = [];
  const failoverFetch = makeMockRpcFetch({
    perUrlHandler: async (url) => {
      attemptUrls.push(url);
      if (url === CANONICAL_CHAINS.base.rpcs[0]) {
        return new Response("busy", { status: 503 });
      }
      return null;
    },
    overrides: {
      receipt: {
        status: "0x1",
        from: SAMPLE_FROM,
        logs: [
          {
            address: BASE_USDC_ADDRESS,
            topics: [ERC20_TRANSFER_TOPIC, payerTopic, treasuryTopic],
            data: "0x2710"
          }
        ]
      }
    }
  });
  const failoverOk = await verifyBaseUsdcPayment("0x" + "2".repeat(64), 10000n, new Set(), failoverFetch);
  assert.equal(failoverOk.ok, true);
  assert.equal(attemptUrls[0], CANONICAL_CHAINS.base.rpcs[0]);
  assert.equal(attemptUrls[1], CANONICAL_CHAINS.base.rpcs[1]);
});

test("authorizeRequest enforces B2B KYB verification status fail-closed", async () => {
  const b2bKeys = new Map([
    ["verified-b2b-token", { tier: "growth", kycStatus: "VERIFIED" }],
    ["pending-b2b-token", { tier: "starter", kycStatus: "PENDING" }]
  ]);

  const okRes = await authorizeRequest({
    headers: new Headers({ "X-Api-Key": "verified-b2b-token" }),
    resourcePath: "/v1/gas",
    apiKeys: b2bKeys,
    consumedTxHashes: new Set()
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.tier, "growth");

  const pendingRes = await authorizeRequest({
    headers: new Headers({ "X-Api-Key": "pending-b2b-token" }),
    resourcePath: "/v1/gas",
    apiKeys: b2bKeys,
    consumedTxHashes: new Set()
  });
  assert.equal(pendingRes.ok, false);
  assert.equal(pendingRes.status, 403);
  assert.equal(pendingRes.body.error, "B2B_KYC_VERIFICATION_REQUIRED");
});

// ---------------------------------------------------------------------------
// 5. Node HTTP Server & Cloudflare Worker Handler Tests
// ---------------------------------------------------------------------------

test("Node HTTP server handles /health, /v1/pricing, /v1/rpc-health, 402, x402, API key, 403, and 413", async () => {
  const txHash = "0x" + "f".repeat(64);
  const payerTopic = "0x" + "5".repeat(40).padStart(64, "0");
  const treasuryTopic = "0x" + TREASURY_ADDRESS.slice(2).padStart(64, "0");

  const server = createGasPulseServer({
    fetchImpl: makeMockRpcFetch({
      overrides: {
        receipt: {
          status: "0x1",
          logs: [
            {
              address: BASE_USDC_ADDRESS,
              topics: [ERC20_TRANSFER_TOPIC, payerTopic, treasuryTopic],
              data: "0x2710"
            }
          ]
        }
      }
    }),
    apiKeys: new Set(["b2b-test-key"])
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.equal(healthBody.treasury, TREASURY_ADDRESS);

    const pricingRes = await fetch(`${baseUrl}/v1/pricing`);
    assert.equal(pricingRes.status, 200);
    const pricingBody = await pricingRes.json();
    assert.equal(pricingBody.x402_per_call_usdc, "0.01");

    const rpcHealthRes = await fetch(`${baseUrl}/v1/rpc-health?probe=true&chain=base`);
    assert.equal(rpcHealthRes.status, 200);
    const rpcHealthBody = await rpcHealthRes.json();
    assert.equal(rpcHealthBody.probed, true);
    assert.equal(rpcHealthBody.health.healthyCount, 4);

    // Unauthenticated -> 402
    const r402 = await fetch(`${baseUrl}/v1/gas?chain=base`);
    assert.equal(r402.status, 402);
    const b402 = await r402.json();
    assert.equal(b402.protocol, "x402");
    assert.equal(b402.accepts[0].payTo, TREASURY_ADDRESS);

    // Valid x402 tx -> 200, replay -> 402
    const simX402 = await fetch(`${baseUrl}/v1/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Payment-Tx": txHash },
      body: JSON.stringify({ chain: "base", from: SAMPLE_FROM, to: SAMPLE_TO, data: "0x" })
    });
    assert.equal(simX402.status, 200);
    const simX402Body = await simX402.json();
    assert.equal(simX402Body.simulation.verdict, "PASS");
    assert.equal(simX402Body.paymentReceipt.txHash, txHash);

    const simReplay = await fetch(`${baseUrl}/v1/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Payment-Tx": txHash },
      body: JSON.stringify({ chain: "base", from: SAMPLE_FROM, to: SAMPLE_TO, data: "0x" })
    });
    assert.equal(simReplay.status, 402);

    // B2B key + OFAC target -> 403
    const simBlocked = await fetch(`${baseUrl}/v1/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "b2b-test-key" },
      body: JSON.stringify({ chain: "base", to: SANCTIONED_MIXER })
    });
    assert.equal(simBlocked.status, 403);

    // Oversized body (> 64KB) -> 413
    const bigBody = JSON.stringify({ chain: "base", to: SAMPLE_TO, data: "0x" + "aa".repeat(40000) });
    const r413 = await fetch(`${baseUrl}/v1/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "b2b-test-key" },
      body: bigBody
    });
    assert.equal(r413.status, 413);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Cloudflare Worker entrypoint handles fetch requests cleanly with env bindings", async () => {
  const worker = createWorkerHandler({
    fetchImpl: makeMockRpcFetch()
  });

  const env = { GASPULSE_API_KEYS: "cf-worker-key", RPC_TIMEOUT_MS: "invalid-nan" };

  const res402 = await worker.fetch(new Request("https://gaspulse.example.workers.dev/v1/gas?chain=arbitrum"), env);
  assert.equal(res402.status, 402);

  const res200 = await worker.fetch(
    new Request("https://gaspulse.example.workers.dev/v1/gas?chain=arbitrum", {
      headers: { "X-Api-Key": "cf-worker-key" }
    }),
    env
  );
  assert.equal(res200.status, 200);
  const body = await res200.json();
  assert.equal(body.gas.chain, "arbitrum");
  assert.equal(body.gas.chainId, 42161);

  // Explicit empty apiKeys override must remain authoritative over env.GASPULSE_API_KEYS
  const fixedEmptyWorker = createWorkerHandler({
    fetchImpl: makeMockRpcFetch(),
    apiKeys: ""
  });
  const resFixed401 = await fixedEmptyWorker.fetch(
    new Request("https://gaspulse.example.workers.dev/v1/gas?chain=base", {
      headers: { "X-Api-Key": "cf-worker-key" }
    }),
    env
  );
  assert.equal(resFixed401.status, 401);

  // Also test default export health route directly
  const defaultHealth = await workerDefault.fetch(new Request("https://gaspulse.example.workers.dev/health"), {});
  assert.equal(defaultHealth.status, 200);
});

// ---------------------------------------------------------------------------
// 6. MCP Server Protocol & Stdio Subprocess Tests
// ---------------------------------------------------------------------------

test("MCP dispatcher handles initialize, tools/list, and all 3 GasPulse tools", async () => {
  const dispatch = createMcpDispatcher({ fetchImpl: makeMockRpcFetch() });

  const init = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(init.result.serverInfo.name, "gaspulse-mcp");

  const notif = await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notif, null);

  const list = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ["estimate_gas", "simulate_transaction", "check_rpc_health"]
  );

  const gasCall = await dispatch({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "estimate_gas", arguments: { chain: "base" } }
  });
  const gasParsed = JSON.parse(gasCall.result.content[0].text);
  assert.equal(gasParsed.chain, "base");

  const simCall = await dispatch({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "simulate_transaction", arguments: { chain: "base", from: SAMPLE_FROM, to: SAMPLE_TO } }
  });
  const simParsed = JSON.parse(simCall.result.content[0].text);
  assert.equal(simParsed.verdict, "PASS");

  const healthCall = await dispatch({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "check_rpc_health", arguments: { chain: "base" } }
  });
  const healthParsed = JSON.parse(healthCall.result.content[0].text);
  assert.equal(healthParsed.chainId, 8453);

  const unknownTool = await dispatch({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "nonexistent", arguments: {} }
  });
  assert.equal(unknownTool.error.code, -32602);
});

test("MCP stdio process responds to initialize and tools/list and exits cleanly", async () => {
  const mcpPath = join(PROJECT_ROOT, "src", "mcp_server.mjs");
  const child = spawn(process.execPath, [mcpPath], { stdio: ["pipe", "pipe", "pipe"] });

  const output = await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    child.stdin.end();
  });

  assert.equal(output.code, 0);
  assert.equal(output.stderr, "");
  const lines = output.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].result.serverInfo.name, "gaspulse-mcp");
  assert.equal(lines[1].result.tools.length, 3);
});

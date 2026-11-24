import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeBytecode,
  computeChangeBps,
  decodeAddress,
  decodeStringOrBytes32,
  formatUnits
} from "../src/abi.mjs";
import { ABI_SELECTORS, STORAGE_SLOTS, inspectContractAndInvariants } from "../src/inspector.mjs";
import { diffInspectionSnapshots, formatWebhookPayload } from "../src/diff_alert.mjs";
import {
  BASE_USDC_ADDRESS,
  ERC20_TRANSFER_TOPIC,
  TREASURY_ADDRESS,
  createBoundedReplayStore,
  verifyBaseUsdcPayment
} from "../src/x402.mjs";
import { createAuditPulseServer } from "../src/server.mjs";
import { createWorker } from "../src/worker.mjs";
import { handleMcpMessage } from "../src/mcp_server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_ROOT = path.resolve(__dirname, "..");

function pad32(hexWithoutPrefix) {
  return "0x" + hexWithoutPrefix.toLowerCase().padStart(64, "0");
}

function encodeUint256(val) {
  return pad32(BigInt(val).toString(16));
}

function encodeAddrWord(addr) {
  return pad32(addr.toLowerCase().slice(2));
}

function encodeAbiString(text) {
  const bytes = Buffer.from(text, "utf8");
  const lenHex = bytes.length.toString(16).padStart(64, "0");
  const paddedDataLen = Math.max(1, Math.ceil(bytes.length / 32)) * 64;
  const dataHex = bytes.toString("hex").padEnd(paddedDataLen, "0");
  return "0x" + encodeUint256(32).slice(2) + lenHex + dataHex;
}

function encodeGetReserves(r0, r1, ts = 1700000000) {
  return "0x" + encodeUint256(r0).slice(2) + encodeUint256(r1).slice(2) + encodeUint256(ts).slice(2);
}

/**
 * Stateful mock JSON-RPC router supporting eth_blockNumber, eth_getBalance,
 * eth_getCode, eth_getStorageAt, eth_call(to, selector), eth_getTransactionCount,
 * and eth_getTransactionReceipt.
 */
function makeMockRpcFetch({
  blockNumber = "0x123456",
  balances = {},
  codes = {},
  storages = {},
  calls = {},
  nonces = {},
  receipts = {},
  failOnRpc = false
} = {}) {
  return async (_url, init) => {
    if (failOnRpc) {
      return new Response("Upstream Down", { status: 503 });
    }
    const body = JSON.parse(init.body);
    const { method, params = [] } = body;
    let result = "0x0";

    if (method === "eth_blockNumber") {
      result = blockNumber;
    } else if (method === "eth_getBalance") {
      const addr = String(params[0]).toLowerCase();
      result = balances[addr] ?? "0x0";
    } else if (method === "eth_getTransactionCount") {
      const addr = String(params[0]).toLowerCase();
      result = nonces[addr] ?? "0x5";
    } else if (method === "eth_getCode") {
      const addr = String(params[0]).toLowerCase();
      result = codes[addr] ?? "0x";
    } else if (method === "eth_getStorageAt") {
      const addr = String(params[0]).toLowerCase();
      const slot = String(params[1]).toLowerCase();
      result = storages[`${addr}:${slot}`] ?? "0x" + "0".repeat(64);
    } else if (method === "eth_call") {
      const txObj = params[0] || {};
      const to = String(txObj.to || "").toLowerCase();
      const data = String(txObj.data || "").toLowerCase();
      const selector = data.slice(0, 10);
      const exactKey = `${to}:${data}`;
      const selKey = `${to}:${selector}`;
      const res = calls[exactKey] ?? calls[selKey];
      if (res === "__REVERT__") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } }),
          { status: 200 }
        );
      }
      result = res ?? "0x";
    } else if (method === "eth_getTransactionReceipt") {
      const txHash = String(params[0]).toLowerCase();
      result = receipts[txHash] ?? null;
    }

    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  };
}

test("ABI decoders & push-aware bytecode analyzer handle edge cases accurately", async () => {
  // Dynamic ABI string vs legacy bytes32 (e.g. MKR)
  assert.equal(decodeStringOrBytes32(encodeAbiString("USD Coin")), "USD Coin");
  const mkrBytes32 = "0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0");
  assert.equal(decodeStringOrBytes32(mkrBytes32), "MKR");

  // Address decoder must reject dirty upper 12 bytes
  assert.equal(decodeAddress("0x000000000000000000000001" + "a".repeat(40)), null);
  assert.equal(decodeAddress(encodeAddrWord("0x1111111111111111111111111111111111111111")), "0x1111111111111111111111111111111111111111");

  // Bytecode PUSH1 0xff (0x60 0xff 0x00) must NOT trigger SELFDESTRUCT false positive
  const pushConstantOnly = await analyzeBytecode("0x60ff00");
  assert.equal(pushConstantOnly.opcodes.selfdestruct, false);

  // Real SELFDESTRUCT outside push data MUST trigger
  const realSelfDestruct = await analyzeBytecode("0x6001ff");
  assert.equal(realSelfDestruct.opcodes.selfdestruct, true);

  // EIP-1167 minimal proxy extraction
  const impl = "1234567890abcdef1234567890abcdef12345678";
  const minimal = await analyzeBytecode(`0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`);
  assert.equal(minimal.minimalProxyTarget, "0x" + impl);

  // Exact BigInt unit formatting and BPS delta
  assert.equal(formatUnits(1500000000000000000n, 18), "1.5");
  assert.equal(computeChangeBps(1000000000000000000000n, 850000000000000000000n), -1500);
});

test("inspector blocks OFAC/sanctioned address and rejects bad inputs", async () => {
  await assert.rejects(() => inspectContractAndInvariants("not-an-address"), /Invalid EVM address/);
  await assert.rejects(
    () => inspectContractAndInvariants("0x0000000000000000000000000000000000000000"),
    /zero address/
  );
  await assert.rejects(
    () => inspectContractAndInvariants("0x1111111111111111111111111111111111111111", { chain: "solana" }),
    /Unsupported chain/
  );

  const report = await inspectContractAndInvariants("0x8589427373d6d84e98730d7795d8f6f8731fda16", {
    chain: "base",
    fetchImpl: makeMockRpcFetch()
  });
  assert.equal(report.riskScore, 100);
  assert.equal(report.riskLevel, "CRITICAL");
  assert.equal(report.invariantsPassed, false);
});

test("inspector checks EIP-1967 proxy, missing implementation code, EOA admin, and paused state", async () => {
  const proxyAddr = "0x2222222222222222222222222222222222222222";
  const implAddr = "0x3333333333333333333333333333333333333333";
  const adminAddr = "0x4444444444444444444444444444444444444444";
  const pendingAddr = "0x5555555555555555555555555555555555555555";

  const mockFetch = makeMockRpcFetch({
    codes: {
      [proxyAddr]: "0x6080604052",
      [implAddr]: "0x", // empty implementation!
      [adminAddr]: "0x" // EOA admin!
    },
    storages: {
      [`${proxyAddr}:${STORAGE_SLOTS.EIP1967_IMPL}`]: encodeAddrWord(implAddr),
      [`${proxyAddr}:${STORAGE_SLOTS.EIP1967_ADMIN}`]: encodeAddrWord(adminAddr)
    },
    calls: {
      [`${proxyAddr}:${ABI_SELECTORS.pendingOwner}`]: encodeAddrWord(pendingAddr),
      [`${proxyAddr}:${ABI_SELECTORS.paused}`]: encodeUint256(1)
    }
  });

  const report = await inspectContractAndInvariants(proxyAddr, { chain: "base", fetchImpl: mockFetch });
  assert.equal(report.proxy.isProxy, true);
  assert.equal(report.proxy.implementationAddress, implAddr);
  assert.equal(report.proxy.implementationHasCode, false);
  assert.equal(report.admin.effectiveAdmin, adminAddr);
  assert.equal(report.admin.effectiveAdminIsEoa, true);
  assert.equal(report.admin.paused, true);
  assert.equal(report.riskLevel, "CRITICAL");
  assert.equal(report.invariantsPassed, false);
  const codes = new Set(report.flags.map((f) => f.code));
  assert.ok(codes.has("PROXY_IMPLEMENTATION_NO_CODE"));
  assert.ok(codes.has("EOA_ADMIN_CONTROL"));
  assert.ok(codes.has("PENDING_OWNERSHIP_TRANSFER"));
  assert.ok(codes.has("CONTRACT_PAUSED"));
});

test("inspector checks ERC-20 totalSupply/decimals sanity and flags anomalies", async () => {
  const tokenAddr = "0x6666666666666666666666666666666666666666";
  const multisigAddr = "0x7777777777777777777777777777777777777777";

  const healthyFetch = makeMockRpcFetch({
    codes: { [tokenAddr]: "0x60806040", [multisigAddr]: "0x60806040" },
    calls: {
      [`${tokenAddr}:${ABI_SELECTORS.owner}`]: encodeAddrWord(multisigAddr),
      [`${tokenAddr}:${ABI_SELECTORS.totalSupply}`]: encodeUint256(1000000000n),
      [`${tokenAddr}:${ABI_SELECTORS.decimals}`]: encodeUint256(6),
      [`${tokenAddr}:${ABI_SELECTORS.symbol}`]: encodeAbiString("USDC"),
      [`${tokenAddr}:${ABI_SELECTORS.name}`]: encodeAbiString("USD Coin")
    }
  });

  const healthy = await inspectContractAndInvariants(tokenAddr, { chain: "base", fetchImpl: healthyFetch });
  assert.equal(healthy.contractType, "ERC20");
  assert.equal(healthy.erc20.symbol, "USDC");
  assert.equal(healthy.erc20.decimals, 6);
  assert.equal(healthy.erc20.totalSupplyFormatted, "1000");
  assert.equal(healthy.invariantsPassed, true);

  const brokenFetch = makeMockRpcFetch({
    codes: { [tokenAddr]: "0x60806040" },
    calls: {
      [`${tokenAddr}:${ABI_SELECTORS.totalSupply}`]: encodeUint256(1n << 252n),
      [`${tokenAddr}:${ABI_SELECTORS.decimals}`]: encodeUint256(77),
      [`${tokenAddr}:${ABI_SELECTORS.symbol}`]: encodeAbiString("BAD")
    }
  });

  const broken = await inspectContractAndInvariants(tokenAddr, { chain: "base", fetchImpl: brokenFetch });
  assert.equal(broken.invariantsPassed, false);
  const flagCodes = new Set(broken.flags.map((f) => f.code));
  assert.ok(flagCodes.has("ERC20_INVALID_DECIMALS"));
  assert.ok(flagCodes.has("ERC20_EXTREME_TOTAL_SUPPLY"));
});

test("inspector checks Uniswap V2 pool reserve invariants and ERC-4626 vault backing", async () => {
  const poolAddr = "0x8888888888888888888888888888888888888888";
  const tok0 = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const tok1 = "0x4200000000000000000000000000000000000006";
  const balCall = ABI_SELECTORS.balanceOf + poolAddr.slice(2).padStart(64, "0");

  // 1. Healthy V2 Pool
  const okPoolFetch = makeMockRpcFetch({
    balances: { [poolAddr]: "0x0" },
    codes: { [poolAddr]: "0x60806040" },
    calls: {
      [`${poolAddr}:${ABI_SELECTORS.getReserves}`]: encodeGetReserves(500000000n, 200000000000000000n),
      [`${poolAddr}:${ABI_SELECTORS.token0}`]: encodeAddrWord(tok0),
      [`${poolAddr}:${ABI_SELECTORS.token1}`]: encodeAddrWord(tok1),
      [`${poolAddr}:${ABI_SELECTORS.totalSupply}`]: encodeUint256(1000000n),
      [`${tok0}:${balCall}`]: encodeUint256(500000000n),
      [`${tok0}:${ABI_SELECTORS.symbol}`]: encodeAbiString("USDC"),
      [`${tok0}:${ABI_SELECTORS.decimals}`]: encodeUint256(6),
      [`${tok1}:${balCall}`]: encodeUint256(200000000000000000n),
      [`${tok1}:${ABI_SELECTORS.symbol}`]: encodeAbiString("WETH"),
      [`${tok1}:${ABI_SELECTORS.decimals}`]: encodeUint256(18)
    }
  });

  const okPool = await inspectContractAndInvariants(poolAddr, { chain: "base", fetchImpl: okPoolFetch });
  assert.equal(okPool.contractType, "UNISWAP_V2");
  assert.equal(okPool.invariantsPassed, true);
  assert.equal(okPool.pool.actualBalance0, "500000000");
  assert.equal(okPool.pool.actualBalance1, "200000000000000000");
  assert.equal(okPool.pool.constantProductK, (500000000n * 200000000000000000n).toString());
  assert.equal(okPool.reserves.tokens.length, 2);
  assert.equal(okPool.reserves.tokens[0].balanceFormatted, "500");
  assert.equal(okPool.reserves.tokens[1].balanceFormatted, "0.2");

  // 2. Undercollateralized V2 Pool (actualBalance0 < reserve0) + >5% unsynced surplus on token1
  const insolventPoolFetch = makeMockRpcFetch({
    codes: { [poolAddr]: "0x60806040" },
    calls: {
      [`${poolAddr}:${ABI_SELECTORS.getReserves}`]: encodeGetReserves(500000000n, 200000000000000000n),
      [`${poolAddr}:${ABI_SELECTORS.token0}`]: encodeAddrWord(tok0),
      [`${poolAddr}:${ABI_SELECTORS.token1}`]: encodeAddrWord(tok1),
      [`${tok0}:${balCall}`]: encodeUint256(100000000n), // shortfall!
      [`${tok1}:${balCall}`]: encodeUint256(250000000000000000n) // >5% surplus!
    }
  });

  const badPool = await inspectContractAndInvariants(poolAddr, { chain: "base", fetchImpl: insolventPoolFetch });
  assert.equal(badPool.riskLevel, "CRITICAL");
  assert.equal(badPool.invariantsPassed, false);
  const poolCodes = new Set(badPool.flags.map((f) => f.code));
  assert.ok(poolCodes.has("POOL_RESERVE_UNDERCOLLATERALIZED"));
  assert.ok(poolCodes.has("POOL_RESERVE_UNSYNCED_SURPLUS"));

  // 3. V2 Pool with zero reserves + V3 Pool with zero active liquidity
  const zeroReserveFetch = makeMockRpcFetch({
    codes: { [poolAddr]: "0x60806040" },
    calls: {
      [`${poolAddr}:${ABI_SELECTORS.getReserves}`]: encodeGetReserves(0n, 1000n),
      [`${poolAddr}:${ABI_SELECTORS.token0}`]: encodeAddrWord(tok0),
      [`${poolAddr}:${ABI_SELECTORS.token1}`]: encodeAddrWord(tok1)
    }
  });
  const zeroPool = await inspectContractAndInvariants(poolAddr, { chain: "base", fetchImpl: zeroReserveFetch });
  assert.equal(zeroPool.riskLevel, "HIGH");
  assert.ok(zeroPool.flags.some((f) => f.code === "POOL_ZERO_RESERVES"));

  const v3Addr = "0x7777777777777777777777777777777777777778";
  const v3Fetch = makeMockRpcFetch({
    codes: { [v3Addr]: "0x60806040" },
    calls: {
      [`${v3Addr}:${ABI_SELECTORS.token0}`]: encodeAddrWord(tok0),
      [`${v3Addr}:${ABI_SELECTORS.token1}`]: encodeAddrWord(tok1),
      [`${v3Addr}:${ABI_SELECTORS.slot0}`]: "0x" + encodeUint256(1n << 96n).slice(2) + encodeUint256(0n).slice(2),
      [`${v3Addr}:${ABI_SELECTORS.liquidity}`]: encodeUint256(0n)
    }
  });
  const v3Pool = await inspectContractAndInvariants(v3Addr, { chain: "base", fetchImpl: v3Fetch });
  assert.equal(v3Pool.contractType, "UNISWAP_V3");
  assert.ok(v3Pool.flags.some((f) => f.code === "POOL_V3_ZERO_LIQUIDITY"));

  // 4. Insolvent ERC-4626 Vault
  const vaultAddr = "0x9999999999999999999999999999999999999999";
  const vaultBalCall = ABI_SELECTORS.balanceOf + vaultAddr.slice(2).padStart(64, "0");
  const badVaultFetch = makeMockRpcFetch({
    codes: { [vaultAddr]: "0x60806040" },
    calls: {
      [`${vaultAddr}:${ABI_SELECTORS.asset}`]: encodeAddrWord(tok0),
      [`${vaultAddr}:${ABI_SELECTORS.totalAssets}`]: encodeUint256(0n),
      [`${vaultAddr}:${ABI_SELECTORS.totalSupply}`]: encodeUint256(100000n),
      [`${tok0}:${vaultBalCall}`]: encodeUint256(0n)
    }
  });
  const badVault = await inspectContractAndInvariants(vaultAddr, { chain: "base", fetchImpl: badVaultFetch });
  assert.equal(badVault.contractType, "ERC4626_VAULT");
  assert.equal(badVault.pool.actualAssetBalance, "0");
  assert.equal(badVault.riskLevel, "CRITICAL");
  assert.ok(badVault.flags.some((f) => f.code === "VAULT_INSOLVENT_ZERO_ASSETS"));

  // 5. ERC-4626 Vault with actual underlying balance < totalAssets
  const shortfallVaultFetch = makeMockRpcFetch({
    codes: { [vaultAddr]: "0x60806040" },
    calls: {
      [`${vaultAddr}:${ABI_SELECTORS.asset}`]: encodeAddrWord(tok0),
      [`${vaultAddr}:${ABI_SELECTORS.totalAssets}`]: encodeUint256(500000n),
      [`${vaultAddr}:${ABI_SELECTORS.totalSupply}`]: encodeUint256(500000n),
      [`${tok0}:${vaultBalCall}`]: encodeUint256(250000n)
    }
  });
  const shortfallVault = await inspectContractAndInvariants(vaultAddr, { chain: "base", fetchImpl: shortfallVaultFetch });
  assert.equal(shortfallVault.riskLevel, "CRITICAL");
  assert.ok(shortfallVault.flags.some((f) => f.code === "VAULT_ASSET_SHORTFALL"));
});

test("diff engine and webhook formatter detect upgrades, admin swaps, supply mints, and reserve drops", async () => {
  const baseline = {
    address: "0x8888888888888888888888888888888888888888",
    chain: "base",
    blockNumber: 1000,
    riskScore: 15,
    bytecode: { isContract: true, bytecodeSha256: "aaa", opcodes: { selfdestruct: false } },
    proxy: { implementationAddress: "0x1111111111111111111111111111111111111111" },
    admin: { effectiveAdmin: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", proxyAdmin: null, pendingOwner: null, paused: false },
    erc20: { decimals: 18, totalSupplyRaw: "1000000000000000000000" },
    pool: { reserve0: "100000000", reserve1: "2000000000000000000", constantProductK: "200000000000000000000000000" },
    reserves: {
      nativeWei: "1000000000000000000",
      tokens: [{ token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", balanceRaw: "100000000" }]
    },
    flags: []
  };

  const mutated = {
    ...baseline,
    blockNumber: 1050,
    riskScore: 95,
    bytecode: { isContract: true, bytecodeSha256: "bbb", opcodes: { selfdestruct: true } },
    proxy: { implementationAddress: "0x2222222222222222222222222222222222222222" },
    admin: { effectiveAdmin: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", proxyAdmin: null, pendingOwner: null, paused: true },
    erc20: { decimals: 18, totalSupplyRaw: "2000000000000000000000" }, // +100% mint!
    pool: { reserve0: "40000000", reserve1: "2000000000000000000", constantProductK: "80000000000000000000000000" }, // -60% reserve0/k!
    reserves: {
      nativeWei: "500000000000000000",
      tokens: [{ token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", balanceRaw: "40000000" }]
    },
    flags: [{ code: "CONTRACT_PAUSED", severity: "HIGH", detail: "Contract paused" }]
  };

  const diff = diffInspectionSnapshots(baseline, mutated);
  assert.equal(diff.alertTriggered, true);
  assert.equal(diff.alertSeverity, "CRITICAL");
  assert.equal(diff.riskScoreDelta, 80);

  const changeTypes = new Set(diff.changes.map((c) => c.type));
  assert.ok(changeTypes.has("BYTECODE_CHANGED"));
  assert.ok(changeTypes.has("PROXY_IMPLEMENTATION_CHANGED"));
  assert.ok(changeTypes.has("ADMIN_CHANGED"));
  assert.ok(changeTypes.has("CONTRACT_PAUSED_TRIGGERED"));
  assert.ok(changeTypes.has("SUPPLY_INFLATED"));
  assert.ok(changeTypes.has("POOL_RESERVE0_DROP"));
  assert.ok(changeTypes.has("POOL_K_INVARIANT_DROP"));
  assert.ok(changeTypes.has("TOKEN_RESERVE_DROP"));

  const generic = formatWebhookPayload(diff, "generic");
  assert.equal(generic.event, "auditpulse.risk_diff.v1");
  assert.equal(generic.triggered, true);

  const slack = formatWebhookPayload(diff, "slack");
  assert.ok(Array.isArray(slack.blocks) && slack.blocks.length >= 2);

  const discord = formatWebhookPayload(diff, "discord");
  assert.ok(Array.isArray(discord.embeds) && discord.embeds.length === 1);

  assert.throws(() => formatWebhookPayload(diff, "teams"), /Unsupported webhook format/);
  assert.throws(
    () => diffInspectionSnapshots(baseline, mutated, { reserveDropPctThreshold: "bad" }),
    /reserveDropPctThreshold/
  );
});

test("x402 Base USDC verification validates amount, recipient, AML payer, and bounded replay", async () => {
  const txOk = "0x" + "a".repeat(64);
  const txBadPayer = "0x" + "b".repeat(64);
  const txLow = "0x" + "c".repeat(64);
  const payerTopic = encodeAddrWord("0x1111111111111111111111111111111111111111");
  const mixerTopic = encodeAddrWord("0x8589427373d6d84e98730d7795d8f6f8731fda16");
  const treasuryTopic = encodeAddrWord(TREASURY_ADDRESS);

  const mockFetch = makeMockRpcFetch({
    receipts: {
      [txOk]: {
        status: "0x1",
        logs: [{ address: BASE_USDC_ADDRESS, topics: [ERC20_TRANSFER_TOPIC, payerTopic, treasuryTopic], data: "0x4e20" }] // 20000 ($0.02)
      },
      [txBadPayer]: {
        status: "0x1",
        logs: [{ address: BASE_USDC_ADDRESS, topics: [ERC20_TRANSFER_TOPIC, mixerTopic, treasuryTopic], data: "0x4e20" }]
      },
      [txLow]: {
        status: "0x1",
        logs: [{ address: BASE_USDC_ADDRESS, topics: [ERC20_TRANSFER_TOPIC, payerTopic, treasuryTopic], data: "0x64" }] // 100 ($0.0001)
      }
    }
  });

  const store = createBoundedReplayStore(2);
  const ok = await verifyBaseUsdcPayment(txOk, 20000n, store, mockFetch);
  assert.equal(ok.ok, true);
  assert.equal(ok.transferredUnits, "20000");

  const replay = await verifyBaseUsdcPayment(txOk, 20000n, store, mockFetch);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "TX_ALREADY_CONSUMED");

  const blockedPayer = await verifyBaseUsdcPayment(txBadPayer, 20000n, store, mockFetch);
  assert.equal(blockedPayer.ok, false);
  assert.equal(blockedPayer.reason, "PAYER_BLOCKED_BY_AML");

  const low = await verifyBaseUsdcPayment(txLow, 20000n, store, mockFetch);
  assert.equal(low.ok, false);
  assert.equal(low.reason, "INSUFFICIENT_USDC_AMOUNT");

  // Eviction test on bounded store (cap=2)
  store.add("0x" + "1".repeat(64));
  store.add("0x" + "2".repeat(64));
  assert.equal(store.size, 2);
  assert.equal(store.has(txOk), false);
});

test("Node HTTP server and Cloudflare Worker share routes, x402 auth, and live /v1/diff", async () => {
  const tokenAddr = "0x6666666666666666666666666666666666666666";
  const txHash = "0x" + "d".repeat(64);
  const payerTopic = encodeAddrWord("0x1111111111111111111111111111111111111111");
  const treasuryTopic = encodeAddrWord(TREASURY_ADDRESS);

  const mockFetch = makeMockRpcFetch({
    blockNumber: "0x200",
    codes: { [tokenAddr]: "0x60806040" },
    calls: {
      [`${tokenAddr}:${ABI_SELECTORS.totalSupply}`]: encodeUint256(500000000n),
      [`${tokenAddr}:${ABI_SELECTORS.decimals}`]: encodeUint256(6),
      [`${tokenAddr}:${ABI_SELECTORS.symbol}`]: encodeAbiString("TST")
    },
    receipts: {
      [txHash]: {
        status: "0x1",
        logs: [{ address: BASE_USDC_ADDRESS, topics: [ERC20_TRANSFER_TOPIC, payerTopic, treasuryTopic], data: "0x4e20" }]
      }
    }
  });

  // 1. Test Node HTTP Server
  const server = createAuditPulseServer({
    fetchImpl: mockFetch,
    apiKeys: new Set(["b2b-secret-1"])
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.status, "ok");
    assert.equal(health.treasury, TREASURY_ADDRESS);

    const pricing = await (await fetch(`${baseUrl}/v1/pricing`)).json();
    assert.equal(pricing.x402_per_call_usdc.inspect, "0.02");
    assert.equal(pricing.b2b_plans_usdc_monthly.starter, 149);

    const res402 = await fetch(`${baseUrl}/v1/inspect?address=${tokenAddr}&chain=base`);
    assert.equal(res402.status, 402);
    const body402 = await res402.json();
    assert.equal(body402.protocol, "x402");
    assert.equal(body402.accepts[0].payTo, TREASURY_ADDRESS);

    const resPaid = await fetch(`${baseUrl}/v1/inspect?address=${tokenAddr}&chain=base`, {
      headers: { "X-Payment-Tx": txHash }
    });
    assert.equal(resPaid.status, 200);
    const paidBody = await resPaid.json();
    assert.equal(paidBody.report.erc20.symbol, "TST");
    assert.equal(paidBody.paymentReceipt.txHash, txHash);

    // Live /v1/diff using previous snapshot with higher supply -> detects contraction
    const prevSnapshot = {
      ...paidBody.report,
      blockNumber: 100,
      erc20: { ...paidBody.report.erc20, totalSupplyRaw: "1000000000" }
    };
    const diffRes = await fetch(`${baseUrl}/v1/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "b2b-secret-1" },
      body: JSON.stringify({ previous: prevSnapshot, format: "slack" })
    });
    assert.equal(diffRes.status, 200);
    const diffBody = await diffRes.json();
    assert.equal(diffBody.diff.alertTriggered, true);
    assert.ok(diffBody.diff.changes.some((c) => c.type === "SUPPLY_CONTRACTED"));
    assert.ok(Array.isArray(diffBody.webhook.blocks));
  } finally {
    server.close();
    server.closeAllConnections?.();
  }

  // 2. Test Cloudflare Worker Entry
  const worker = createWorker({ fetchImpl: mockFetch });
  const env = { AUDITPULSE_API_KEYS: "cf-key-1, cf-key-2" };

  const worker402 = await worker.fetch(new Request(`https://auditpulse.example/v1/inspect?address=${tokenAddr}`), env);
  assert.equal(worker402.status, 402);

  const worker200 = await worker.fetch(
    new Request(`https://auditpulse.example/v1/inspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "cf-key-2" },
      body: JSON.stringify({ address: tokenAddr, chain: "base" })
    }),
    env
  );
  assert.equal(worker200.status, 200);
  const wBody = await worker200.json();
  assert.equal(wBody.report.erc20.symbol, "TST");

  const worker405 = await worker.fetch(new Request(`https://auditpulse.example/v1/diff`, { method: "GET" }), env);
  assert.equal(worker405.status, 405);

  const workerCors = await worker.fetch(new Request(`https://auditpulse.example/v1/inspect`, { method: "OPTIONS" }), env);
  assert.equal(workerCors.status, 204);

  // Upstream RPC failure returns 502 cleanly
  const brokenWorker = createWorker({ fetchImpl: makeMockRpcFetch({ failOnRpc: true }) });
  const worker502 = await brokenWorker.fetch(
    new Request(`https://auditpulse.example/v1/inspect?address=${tokenAddr}`, {
      headers: { "X-Api-Key": "cf-key-1" }
    }),
    env
  );
  assert.equal(worker502.status, 502);
});

test("MCP server handles JSON-RPC tools and stdio subprocess roundtrip cleanly", async () => {
  const tokenAddr = "0x6666666666666666666666666666666666666666";
  const mockFetch = makeMockRpcFetch({
    codes: { [tokenAddr]: "0x60806040" },
    calls: {
      [`${tokenAddr}:${ABI_SELECTORS.totalSupply}`]: encodeUint256(1000n),
      [`${tokenAddr}:${ABI_SELECTORS.decimals}`]: encodeUint256(6),
      [`${tokenAddr}:${ABI_SELECTORS.symbol}`]: encodeAbiString("MCP")
    }
  });

  const initRes = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(initRes.result.serverInfo.name, "auditpulse-mcp");

  const notifRes = await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notifRes, null);

  const listRes = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listRes.result.tools.length, 3);

  const callRes = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "inspect_contract_invariants", arguments: { address: tokenAddr, chain: "base" } }
    },
    { fetchImpl: mockFetch }
  );
  const parsed = JSON.parse(callRes.result.content[0].text);
  assert.equal(parsed.erc20.symbol, "MCP");

  const diffCallRes = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "diff_contract_snapshots",
        arguments: {
          previous: { ...parsed, erc20: { ...parsed.erc20, totalSupplyRaw: "5000" } },
          format: "discord"
        }
      }
    },
    { fetchImpl: mockFetch }
  );
  const diffParsed = JSON.parse(diffCallRes.result.content[0].text);
  assert.equal(diffParsed.diff.alertTriggered, true);
  assert.equal(diffParsed.webhook.embeds.length, 1);

  const txHash = "0x" + "e".repeat(64);
  const payMockFetch = makeMockRpcFetch({
    receipts: {
      [txHash]: {
        status: "0x1",
        logs: [
          {
            address: BASE_USDC_ADDRESS,
            topics: [
              ERC20_TRANSFER_TOPIC,
              encodeAddrWord("0x1111111111111111111111111111111111111111"),
              encodeAddrWord(TREASURY_ADDRESS)
            ],
            data: "0x4e20"
          }
        ]
      }
    }
  });
  const payCallRes = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "verify_x402_payment", arguments: { txHash } }
    },
    { fetchImpl: payMockFetch }
  );
  const payParsed = JSON.parse(payCallRes.result.content[0].text);
  assert.equal(payParsed.ok, true);

  // Real stdio subprocess verification for initialize + tools/list
  const child = spawn(process.execPath, [path.join(PRODUCT_ROOT, "src", "mcp_server.mjs")], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list" }) + "\n");
  child.stdin.end();

  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`MCP exited with ${code}`))));
  });

  const lines = stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, 10);
  assert.equal(lines[1].result.tools.length, 3);
});

test("heap footprint stays under 40 MB and treasury/docs hygiene is clean", async () => {
  const { rss, heapUsed } = process.memoryUsage();
  const heapMb = heapUsed / (1024 * 1024);
  const rssMb = rss / (1024 * 1024);
  assert.ok(heapMb < 40, `Expected heapUsed < 40 MB, got ${heapMb.toFixed(2)} MB`);
  assert.ok(rssMb < 120, `Expected reasonable test runner RSS, got ${rssMb.toFixed(2)} MB`);
  assert.equal(TREASURY_ADDRESS, "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c");

  const filesToScan = [
    "package.json",
    "wrangler.toml",
    "README.md",
    "DEPLOY.md",
    "src/chains.mjs",
    "src/abi.mjs",
    "src/x402.mjs",
    "src/inspector.mjs",
    "src/diff_alert.mjs",
    "src/handler.mjs",
    "src/server.mjs",
    "src/worker.mjs",
    "src/mcp_server.mjs",
    "tests/auditpulse.test.mjs"
  ];
  const userPathRegex = new RegExp(["C:", "Users", "[^\\\\]+", ""].join("\\\\"));

  for (const rel of filesToScan) {
    const content = await fs.readFile(path.join(PRODUCT_ROOT, rel), "utf8");
    assert.equal(userPathRegex.test(content), false, `${rel} must not contain local home path`);
  }
});

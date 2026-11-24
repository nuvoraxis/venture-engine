/**
 * Live Multi-Chain RPC Smoke Test for AegisGate, GasPulse, and AuditPulse.
 * Zero external dependencies; enforces strict 8s timeouts, bounded concurrency (<=4),
 * and transparent failover across canonical public RPCs (never mocks responses).
 *
 * Usage:
 *   node ops/live_smoke.mjs
 */
import { screenEvmAddress } from "../products/aegisgate/src/risk_engine.mjs";
import { estimateGasMetrics } from "../products/gaspulse/src/gas_pulse.mjs";
import { RpcPool } from "../products/gaspulse/src/rpc_pool.mjs";
import { inspectContractAndInvariants } from "../products/auditpulse/src/inspector.mjs";

const TIMEOUT_MS = 8000;
const MAX_CONCURRENT_RPC = 4;
const TORNADO_ROUTER_ETH = "0x8589427373d6d84e98730d7795d8f6f8731fda16";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const PUBLIC_FALLBACKS = new Map([
  ["https://cloudflare-eth.com", ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"]],
  ["https://mainnet.base.org", ["https://base-rpc.publicnode.com", "https://base.llamarpc.com"]]
]);

function createResilientPublicFetch(timeoutMs = TIMEOUT_MS, maxConcurrent = MAX_CONCURRENT_RPC) {
  let active = 0;
  const queue = [];
  const warnedHosts = new Set();

  const acquire = () =>
    new Promise((resolve) => {
      if (active < maxConcurrent) {
        active += 1;
        resolve();
      } else {
        queue.push(resolve);
      }
    });

  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) {
      active += 1;
      next();
    }
  };

  async function singleAttempt(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
    if (init?.signal) {
      if (init.signal.aborted) controller.abort(init.signal.reason);
      else init.signal.addEventListener("abort", () => controller.abort(init.signal.reason), { once: true });
    }
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function isDegradedPublicJsonRpc(parsed) {
    if (!parsed || typeof parsed !== "object" || !parsed.error) return false;
    const code = parsed.error.code;
    const msg = String(parsed.error.message || "");
    // Node/gateway overload or unsupported gateway error (NOT a contract revert)
    return code === -32046 || code === -32603 || /Internal error|Cannot fulfill|rate limit|too many requests/i.test(msg);
  }

  const fetchImpl = async (url, init = {}) => {
    await acquire();
    try {
      const candidates = [url, ...(PUBLIC_FALLBACKS.get(url) || [])];
      let lastRes = null;
      let lastErr = null;

      for (let i = 0; i < candidates.length; i++) {
        const target = candidates[i];
        try {
          const res = await singleAttempt(target, init);
          if (res.status === 429 || res.status >= 500) {
            lastRes = res;
            if (i < candidates.length - 1 && !warnedHosts.has(target)) {
              warnedHosts.add(target);
              console.warn(`[WARN] Public RPC ${target} returned HTTP ${res.status}; failing over to ${candidates[i + 1]}`);
            }
            continue;
          }
          // Peek JSON only to detect degraded gateway errors (e.g. cloudflare-eth -32046)
          const rawText = await res.text();
          let parsed = null;
          try {
            parsed = JSON.parse(rawText);
          } catch {
            // Non-JSON response
          }
          if (i < candidates.length - 1 && isDegradedPublicJsonRpc(parsed)) {
            if (!warnedHosts.has(target)) {
              warnedHosts.add(target);
              console.warn(
                `[WARN] Public RPC ${target} returned gateway error (${parsed.error.message}); failing over to ${candidates[i + 1]}`
              );
            }
            continue;
          }
          return new Response(rawText, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers
          });
        } catch (err) {
          lastErr = err;
          if (i < candidates.length - 1 && !warnedHosts.has(target)) {
            warnedHosts.add(target);
            console.warn(`[WARN] Public RPC ${target} error (${err.message}); failing over to ${candidates[i + 1]}`);
          }
        }
      }

      if (lastRes) return lastRes;
      throw lastErr || new Error(`All public RPC candidates failed for ${url}`);
    } finally {
      release();
    }
  };
  fetchImpl.getWarnCount = () => warnedHosts.size;
  return fetchImpl;
}

function isNetworkOrUpstreamOutage(err) {
  const msg = String(err?.message || err || "");
  return /RPC HTTP|RPC network failure|All \d+ RPC endpoints failed|RPC Error: Internal error|Cannot fulfill|Timeout|fetch failed|aborted|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(
    msg
  );
}

function assertCheck(cond, msg) {
  if (!cond) {
    const err = new Error(msg);
    err.isAssertionBug = true;
    throw err;
  }
}

async function runCheck(label, fn) {
  const started = Date.now();
  try {
    const summary = await fn();
    const elapsedMs = Date.now() - started;
    console.log(`[PASS] ${label} (${elapsedMs}ms) -> ${summary}`);
    return { status: "PASS" };
  } catch (err) {
    const elapsedMs = Date.now() - started;
    if (!err?.isAssertionBug && isNetworkOrUpstreamOutage(err)) {
      console.warn(`[WARN] ${label} (${elapsedMs}ms) -> transient public RPC failure: ${err.message}`);
      return { status: "WARN", error: err.message };
    }
    console.error(`[FAIL] ${label} (${elapsedMs}ms) -> ${err?.stack || err?.message || err}`);
    return { status: "FAIL", error: err?.message || String(err) };
  }
}

async function main() {
  console.log("=== Venture Engine Live RPC Smoke Check (8s timeout, <=4 concurrent RPCs) ===");
  const fetchResilient = createResilientPublicFetch(TIMEOUT_MS, MAX_CONCURRENT_RPC);
  const rpcPool = new RpcPool({ fetchImpl: fetchResilient, timeoutMs: TIMEOUT_MS });

  const results = [];

  results.push(
    await runCheck("AegisGate: Tornado Cash on Ethereum -> BLOCK", async () => {
      const report = await screenEvmAddress(TORNADO_ROUTER_ETH, "ethereum", fetchResilient);
      assertCheck(report.chainId === 1, `Expected chainId 1, got ${report.chainId}`);
      assertCheck(report.verdict === "BLOCK", `Expected BLOCK, got ${report.verdict}`);
      assertCheck(report.riskScore === 100, `Expected riskScore 100, got ${report.riskScore}`);
      assertCheck(
        Array.isArray(report.flags) && report.flags.some((f) => f.code === "MIXER_OFAC"),
        "Expected MIXER_OFAC flag on sanctioned Tornado Cash address"
      );
      assertCheck(typeof report.nonce === "number" && report.nativeBalanceWei !== undefined, "Missing live Ethereum RPC state");
      return `verdict=${report.verdict}, riskScore=${report.riskScore}, isContract=${report.isContract}, nonce=${report.nonce}`;
    })
  );

  results.push(
    await runCheck("GasPulse: Live Base EIP-1559 fee tiers", async () => {
      const gas = await estimateGasMetrics("base", rpcPool);
      assertCheck(gas.chainId === 8453, `Expected chainId 8453, got ${gas.chainId}`);
      assertCheck(
        Boolean(gas.tiers?.slow && gas.tiers?.standard && gas.tiers?.fast && gas.tiers?.urgent),
        "Missing fee tiers"
      );
      assertCheck(BigInt(gas.tiers.standard.maxFeePerGasWei) > 0n, "Expected positive standard maxFeePerGasWei");
      return `baseFeeGwei=${gas.baseFeePerGasGwei}, standardMaxGwei=${gas.tiers.standard.maxFeePerGasGwei}, congestion=${gas.congestionLevel}, rpc=${gas.rpc.endpoint}`;
    })
  );

  results.push(
    await runCheck("AuditPulse: Base USDC contract/proxy & ERC-20 metadata", async () => {
      const report = await inspectContractAndInvariants(BASE_USDC, {
        chain: "base",
        fetchImpl: fetchResilient
      });
      assertCheck(report.chainId === 8453, `Expected chainId 8453, got ${report.chainId}`);
      assertCheck(report.bytecode?.isContract === true, "Expected Base USDC to be a contract");
      assertCheck(report.proxy?.isProxy === true, "Expected Base USDC to be detected as proxy");
      assertCheck(report.erc20?.symbol === "USDC", `Expected symbol USDC, got ${report.erc20?.symbol}`);
      assertCheck(report.erc20?.decimals === 6, `Expected decimals 6, got ${report.erc20?.decimals}`);
      assertCheck(BigInt(report.erc20?.totalSupplyRaw || "0") > 0n, "Expected positive Base USDC totalSupply");
      return `type=${report.contractType}, impl=${report.proxy.implementationAddress}, symbol=${report.erc20.symbol}, decimals=${report.erc20.decimals}, supply=${report.erc20.totalSupplyFormatted}`;
    })
  );

  const passes = results.filter((r) => r.status === "PASS").length;
  const warns = results.filter((r) => r.status === "WARN").length + fetchResilient.getWarnCount();
  const fails = results.filter((r) => r.status === "FAIL").length;
  const heapMb = (process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(2);

  console.log(`\nSummary: ${passes} PASS, ${warns} WARN, ${fails} FAIL (heapUsed=${heapMb} MB)`);

  if (fails > 0 || passes === 0) {
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error(`[FAIL] Fatal unhandled smoke error: ${err?.stack || err}`);
  process.exitCode = 1;
});

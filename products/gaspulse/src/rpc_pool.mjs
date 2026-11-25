/**
 * Multi-Chain RPC Latency Tracker, Health Monitor & Circuit-Breaker Failover Pool.
 * Zero external dependencies; bounded fixed-size endpoint state (<10 KB RAM).
 */
import {
  CANONICAL_CHAINS,
  SUPPORTED_CHAIN_NAMES,
  buildChainRpcMap,
  normalizeChain,
  parseHexBigInt
} from "./chains.mjs";

const REVERT_MESSAGE_RE =
  /revert|out of gas|intrinsic gas too low|insufficient funds|gas required exceeds allowance|invalid opcode|stack underflow/i;

/**
 * Distinguishes deterministic EVM contract execution reverts from RPC transport/node faults
 * so healthy RPC nodes are not penalized when a caller simulates a reverting transaction.
 */
export function isDeterministicEvmRevertError(rpcError) {
  if (!rpcError || typeof rpcError !== "object") return false;
  if (rpcError.code === 3 || rpcError.code === -32015) return true;
  if (typeof rpcError.data === "string" && /^0x(08c379a0|4e487b71)/i.test(rpcError.data)) {
    return true;
  }
  if (rpcError.code === -32000 && typeof rpcError.message === "string" && REVERT_MESSAGE_RE.test(rpcError.message)) {
    return true;
  }
  if (typeof rpcError.message === "string" && /execution reverted/i.test(rpcError.message)) {
    return true;
  }
  return false;
}

export function sanitizeRpcUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "invalid-rpc-url";
  }
}

export class RpcPoolError extends Error {
  constructor(message, attempts = []) {
    super(message);
    this.name = "RpcPoolError";
    this.attempts = attempts;
  }
}

export class RpcPool {
  /**
   * @param {object} [opts]
   * @param {Record<string, string[]|string>} [opts.rpcOverrides]
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.failureThreshold]
   * @param {number} [opts.cooldownMs]
   * @param {number} [opts.maxBlockLag]
   * @param {() => number} [opts.nowFn]
   */
  constructor({
    rpcOverrides = {},
    fetchImpl = fetch,
    timeoutMs = 4000,
    failureThreshold = 2,
    cooldownMs = 30000,
    maxBlockLag = 5,
    nowFn = () => Date.now()
  } = {}) {
    this.fetchImpl = (url, init) =>
      fetchImpl === globalThis.fetch ? globalThis.fetch(url, init) : fetchImpl(url, init);
    this.timeoutMs = timeoutMs;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.maxBlockLag = maxBlockLag;
    this.nowFn = nowFn;

    const rpcMap = buildChainRpcMap(rpcOverrides);
    this.endpointsByChain = new Map();
    this.highestBlockByChain = new Map();

    for (const chain of SUPPORTED_CHAIN_NAMES) {
      this.highestBlockByChain.set(chain, null);
      this.endpointsByChain.set(
        chain,
        rpcMap[chain].map((url, index) => ({
          url,
          label: sanitizeRpcUrl(url),
          priority: index,
          status: "unknown",
          ewmaLatencyMs: null,
          lastLatencyMs: null,
          successCount: 0,
          failureCount: 0,
          consecutiveFailures: 0,
          circuitOpenUntil: 0,
          lastBlockNumber: null,
          lagBlocks: 0,
          lastError: null,
          lastCheckedAt: null
        }))
      );
    }
  }

  _getEndpoints(chain) {
    const normalized = normalizeChain(chain);
    return { chain: normalized, endpoints: this.endpointsByChain.get(normalized) };
  }

  _getOrderedEndpoints(chain) {
    const { endpoints } = this._getEndpoints(chain);
    const now = this.nowFn();
    const available = [];
    const tripped = [];

    for (const ep of endpoints) {
      if (ep.circuitOpenUntil > now) {
        tripped.push(ep);
      } else {
        available.push(ep);
      }
    }

    available.sort((a, b) => {
      const aFaulted = a.consecutiveFailures > 0 ? 1 : 0;
      const bFaulted = b.consecutiveFailures > 0 ? 1 : 0;
      if (aFaulted !== bFaulted) return aFaulted - bFaulted;

      const aLagging = a.lagBlocks > this.maxBlockLag ? 1 : 0;
      const bLagging = b.lagBlocks > this.maxBlockLag ? 1 : 0;
      if (aLagging !== bLagging) return aLagging - bLagging;

      const aScore = a.ewmaLatencyMs ?? 120 + a.priority * 10;
      const bScore = b.ewmaLatencyMs ?? 120 + b.priority * 10;
      if (aScore !== bScore) return aScore - bScore;
      return a.priority - b.priority;
    });

    tripped.sort((a, b) => a.circuitOpenUntil - b.circuitOpenUntil);
    return [...available, ...tripped];
  }

  _refreshLag(chain) {
    const endpoints = this.endpointsByChain.get(chain);
    let highest = this.highestBlockByChain.get(chain);
    for (const ep of endpoints) {
      if (ep.lastBlockNumber !== null && (highest === null || ep.lastBlockNumber > highest)) {
        highest = ep.lastBlockNumber;
      }
    }
    this.highestBlockByChain.set(chain, highest);
    if (highest === null) return;

    for (const ep of endpoints) {
      if (ep.lastBlockNumber !== null) {
        ep.lagBlocks = Math.max(0, highest - ep.lastBlockNumber);
        if (ep.consecutiveFailures === 0 && ep.circuitOpenUntil === 0) {
          ep.status = ep.lagBlocks > this.maxBlockLag ? "degraded" : "healthy";
        }
      }
    }
  }

  _recordSuccess(chain, ep, latencyMs, blockNumber = null) {
    const safeLatency = Math.max(1, Math.round(latencyMs));
    ep.successCount += 1;
    ep.consecutiveFailures = 0;
    ep.circuitOpenUntil = 0;
    ep.lastError = null;
    ep.lastLatencyMs = safeLatency;
    ep.ewmaLatencyMs =
      ep.ewmaLatencyMs === null
        ? safeLatency
        : Math.round(ep.ewmaLatencyMs * 0.7 + safeLatency * 0.3);
    ep.lastCheckedAt = new Date(this.nowFn()).toISOString();
    if (blockNumber !== null) {
      ep.lastBlockNumber = blockNumber;
      this._refreshLag(chain);
    } else {
      ep.status = ep.lagBlocks > this.maxBlockLag ? "degraded" : "healthy";
    }
  }

  _recordFailure(ep, latencyMs, reason) {
    ep.failureCount += 1;
    ep.consecutiveFailures += 1;
    ep.lastLatencyMs = Math.max(1, Math.round(latencyMs));
    ep.lastError = String(reason || "Unknown RPC failure").slice(0, 180);
    ep.lastCheckedAt = new Date(this.nowFn()).toISOString();
    if (ep.consecutiveFailures >= this.failureThreshold) {
      ep.status = "open";
      ep.circuitOpenUntil = this.nowFn() + this.cooldownMs;
    } else {
      ep.status = "degraded";
    }
  }

  async _postJsonRpc(ep, method, params, timeoutMs) {
    const started = this.nowFn();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("RPC timeout")), timeoutMs);

    try {
      const res = await this.fetchImpl(ep.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal
      });
      const latencyMs = this.nowFn() - started;
      if (!res.ok) {
        return { transportOk: false, latencyMs, error: `HTTP ${res.status}` };
      }
      const data = await res.json();
      if (!data || typeof data !== "object") {
        return { transportOk: false, latencyMs, error: "Malformed JSON-RPC payload" };
      }
      return { transportOk: true, latencyMs, data };
    } catch (err) {
      const latencyMs = this.nowFn() - started;
      const msg = err?.name === "AbortError" ? `Timeout after ${timeoutMs}ms` : err?.message || "Fetch error";
      return { transportOk: false, latencyMs, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Executes a JSON-RPC call across healthy endpoints with automatic failover.
   * Returns `{ ok: true, result, endpoint, latencyMs, attempts }` or `{ ok: false, reverted: true, rpcError, ... }`.
   * Throws `RpcPoolError` only if every endpoint failed at the transport/node layer.
   */
  async callWithMeta(chain, method, params = [], options = {}) {
    const normalizedChain = normalizeChain(chain);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const ordered = this._getOrderedEndpoints(normalizedChain);
    const attempts = [];

    for (const ep of ordered) {
      const res = await this._postJsonRpc(ep, method, params, timeoutMs);
      if (!res.transportOk) {
        this._recordFailure(ep, res.latencyMs, res.error);
        attempts.push({ endpoint: ep.label, ok: false, latencyMs: res.latencyMs, error: res.error });
        continue;
      }

      if (res.data.error) {
        if (isDeterministicEvmRevertError(res.data.error)) {
          this._recordSuccess(normalizedChain, ep, res.latencyMs);
          attempts.push({ endpoint: ep.label, ok: true, reverted: true, latencyMs: res.latencyMs });
          return {
            ok: false,
            reverted: true,
            rpcError: res.data.error,
            endpoint: ep.label,
            latencyMs: res.latencyMs,
            attempts
          };
        }
        const errMsg = res.data.error.message || `RPC error ${res.data.error.code ?? "unknown"}`;
        this._recordFailure(ep, res.latencyMs, errMsg);
        attempts.push({ endpoint: ep.label, ok: false, latencyMs: res.latencyMs, error: errMsg });
        continue;
      }

      if (!Object.hasOwn(res.data, "result")) {
        this._recordFailure(ep, res.latencyMs, "Missing JSON-RPC result");
        attempts.push({ endpoint: ep.label, ok: false, latencyMs: res.latencyMs, error: "Missing JSON-RPC result" });
        continue;
      }

      const observedBlock =
        method === "eth_blockNumber" && typeof res.data.result === "string"
          ? Number(parseHexBigInt(res.data.result, 0n))
          : null;
      this._recordSuccess(normalizedChain, ep, res.latencyMs, observedBlock);
      attempts.push({ endpoint: ep.label, ok: true, latencyMs: res.latencyMs });

      return {
        ok: true,
        reverted: false,
        result: res.data.result,
        endpoint: ep.label,
        latencyMs: res.latencyMs,
        attempts
      };
    }

    throw new RpcPoolError(
      `All ${ordered.length} RPC endpoints failed for ${normalizedChain} (${method})`,
      attempts
    );
  }

  async call(chain, method, params = [], options = {}) {
    const res = await this.callWithMeta(chain, method, params, options);
    if (!res.ok) {
      throw new Error(res.rpcError?.message || "EVM execution reverted");
    }
    return res.result;
  }

  /**
   * Probes all configured RPC endpoints for a chain concurrently using `eth_blockNumber` + `eth_chainId`.
   */
  async probeChain(chain, options = {}) {
    const { chain: normalizedChain, endpoints } = this._getEndpoints(chain);
    const expectedChainId = CANONICAL_CHAINS[normalizedChain].chainId;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    await Promise.all(
      endpoints.map(async (ep) => {
        const [blockRes, chainIdRes] = await Promise.all([
          this._postJsonRpc(ep, "eth_blockNumber", [], timeoutMs),
          this._postJsonRpc(ep, "eth_chainId", [], timeoutMs)
        ]);

        if (!blockRes.transportOk || blockRes.data.error || typeof blockRes.data.result !== "string") {
          const reason = blockRes.error || blockRes.data?.error?.message || "Invalid eth_blockNumber response";
          this._recordFailure(ep, blockRes.latencyMs, reason);
          return;
        }
        if (!chainIdRes.transportOk || chainIdRes.data.error || typeof chainIdRes.data.result !== "string") {
          const reason = chainIdRes.error || chainIdRes.data?.error?.message || "Invalid eth_chainId response";
          this._recordFailure(ep, chainIdRes.latencyMs, reason);
          return;
        }

        try {
          const reportedChainId = Number(parseHexBigInt(chainIdRes.data.result, 0n));
          if (reportedChainId !== expectedChainId) {
            this._recordFailure(
              ep,
              chainIdRes.latencyMs,
              `Chain ID mismatch: expected ${expectedChainId}, got ${reportedChainId}`
            );
            return;
          }
          const blockNum = Number(parseHexBigInt(blockRes.data.result, 0n));
          this._recordSuccess(normalizedChain, ep, blockRes.latencyMs, blockNum);
        } catch (err) {
          this._recordFailure(ep, blockRes.latencyMs, err.message);
        }
      })
    );

    return this.getHealthSnapshot(normalizedChain);
  }

  async probeAll(options = {}) {
    await Promise.all(SUPPORTED_CHAIN_NAMES.map((chain) => this.probeChain(chain, options)));
    return this.getHealthSnapshot();
  }

  getHealthSnapshot(chain = null) {
    const now = this.nowFn();
    const targetChains = chain ? [normalizeChain(chain)] : SUPPORTED_CHAIN_NAMES;
    const snapshot = {};

    for (const c of targetChains) {
      const endpoints = this.endpointsByChain.get(c);
      const formatted = endpoints.map((ep) => ({
        endpoint: ep.label,
        status: ep.circuitOpenUntil > now ? "open" : ep.status,
        ewmaLatencyMs: ep.ewmaLatencyMs,
        lastLatencyMs: ep.lastLatencyMs,
        successCount: ep.successCount,
        failureCount: ep.failureCount,
        consecutiveFailures: ep.consecutiveFailures,
        lastBlockNumber: ep.lastBlockNumber,
        lagBlocks: ep.lagBlocks,
        circuitOpenUntil: ep.circuitOpenUntil > now ? new Date(ep.circuitOpenUntil).toISOString() : null,
        lastError: ep.lastError,
        lastCheckedAt: ep.lastCheckedAt
      }));

      const activeBest = this._getOrderedEndpoints(c)[0];
      snapshot[c] = {
        chainId: CANONICAL_CHAINS[c].chainId,
        highestBlockNumber: this.highestBlockByChain.get(c),
        activeEndpoint: activeBest ? activeBest.label : null,
        healthyCount: formatted.filter((e) => e.status === "healthy").length,
        totalEndpoints: formatted.length,
        endpoints: formatted
      };
    }

    return chain ? snapshot[normalizeChain(chain)] : snapshot;
  }
}

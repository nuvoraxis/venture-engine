/**
 * Venture Engine Unified Edge Gateway Client SDK (Zero-Dependency ESM, Node >= 20 / Web Fetch).
 * Covers AegisGate, GasPulse, AuditPulse, Portal KYB Checkout, and Remote Streamable HTTP MCP.
 */

export const DEFAULT_GATEWAY_URL = "https://venture-engine-gateway.leonid-ai-global.workers.dev";
export const RECEIVE_ONLY_TREASURY = "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c";
export const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export class VentureEngineError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.name = "VentureEngineError";
    this.status = status;
    this.body = body;
  }
}

export class VentureEngineClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]
   * @param {string} [options.apiKey]
   * @param {string} [options.paymentTx]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {number} [options.timeoutMs]
   */
  constructor({
    baseUrl = DEFAULT_GATEWAY_URL,
    apiKey = null,
    paymentTx = null,
    fetchImpl = fetch,
    timeoutMs = 15000
  } = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
    this.apiKey = apiKey || null;
    this.paymentTx = paymentTx || null;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async _request(method, path, { query = null, body = null, apiKey = undefined, paymentTx = undefined } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
        }
      }
    }

    const headers = { Accept: "application/json" };
    const effectiveKey = apiKey !== undefined ? apiKey : this.apiKey;
    const effectiveTx = paymentTx !== undefined ? paymentTx : this.paymentTx;

    if (effectiveKey) headers["X-Api-Key"] = effectiveKey;
    if (effectiveTx) headers["X-Payment-Tx"] = effectiveTx;
    if (body !== null && body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(new Error(`Request timeout after ${this.timeoutMs}ms`)), this.timeoutMs) : null;

    try {
      const res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        ...(body !== null && body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(controller ? { signal: controller.signal } : {})
      });

      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text };
      }

      if (!res.ok) {
        const msg =
          parsed?.error ||
          parsed?.paymentError ||
          parsed?.code ||
          `HTTP ${res.status}`;
        throw new VentureEngineError(res.status, msg, parsed);
      }
      return parsed;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * AegisGate: Screen an EVM address for OFAC/mixer risk and EIP-1967 proxy status.
   */
  screenAddress(address, { chain = "base", apiKey, paymentTx } = {}) {
    return this._request("GET", "/aegis/v1/screen", {
      query: { address, chain },
      apiKey,
      paymentTx
    });
  }

  /**
   * GasPulse: Estimate EIP-1559 fee tiers and congestion telemetry.
   */
  estimateGas(chain = "base", { apiKey, paymentTx } = {}) {
    const resolvedChain = typeof chain === "object" && chain !== null ? chain.chain || "base" : chain;
    return this._request("GET", "/gaspulse/v1/gas", {
      query: { chain: resolvedChain },
      apiKey,
      paymentTx
    });
  }

  /**
   * GasPulse: Pre-flight eth_call + eth_estimateGas simulation and mempool guard.
   */
  simulateTransaction(payload, { apiKey, paymentTx } = {}) {
    return this._request("POST", "/gaspulse/v1/simulate", {
      body: payload,
      apiKey,
      paymentTx
    });
  }

  /**
   * GasPulse: Multi-chain RPC latency & circuit-breaker health snapshot.
   */
  rpcHealth({ chain, probe } = {}) {
    return this._request("GET", "/gaspulse/v1/rpc-health", {
      query: {
        chain,
        ...(probe !== undefined ? { probe: probe ? "true" : "false" } : {})
      }
    });
  }

  /**
   * AuditPulse: Inspect contract/ERC-20/pool invariants via live JSON-RPC.
   */
  inspectContract(address, { chain = "base", tokens, apiKey, paymentTx } = {}) {
    return this._request("GET", "/auditpulse/v1/inspect", {
      query: { address, chain, tokens },
      apiKey,
      paymentTx
    });
  }

  /**
   * AuditPulse: Diff two inspection snapshots and format webhook alert payloads.
   */
  diffSnapshots(payload, { apiKey, paymentTx } = {}) {
    return this._request("POST", "/auditpulse/v1/diff", {
      body: payload,
      apiKey,
      paymentTx
    });
  }

  /**
   * Portal: Submit self-serve KYB checkout (returns deterministic invoice or PAID_AND_VERIFIED + apiKey).
   */
  kybCheckout(payload) {
    return this._request("POST", "/v1/kyb-checkout", { body: payload });
  }

  /**
   * Portal: Verify Base Mainnet USDC settlement txHash and retrieve stateless ve_live_... apiKey.
   */
  verifyInvoice(payload) {
    return this._request("POST", "/v1/verify-invoice", { body: payload });
  }

  /**
   * Gateway Remote Streamable HTTP MCP: Execute any of the 7 tools over POST /mcp.
   */
  async callMcpTool(name, args = {}, { id = 1, apiKey, paymentTx } = {}) {
    const rpcRes = await this._request("POST", "/mcp", {
      body: {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args }
      },
      apiKey,
      paymentTx
    });
    if (rpcRes?.error) {
      throw new VentureEngineError(400, rpcRes.error.message || "MCP tool error", rpcRes);
    }
    return rpcRes;
  }
}

# Quickstart 02: Pre-Flight Tx Simulation & RPC Failover (GasPulse)

Eliminate reverted transactions, gas overpays, and single-RPC outages in trading bots, wallets, and autonomous agents across **Base**, **Ethereum**, and **Arbitrum**.

- **Unified Gateway Endpoints:** `GET /gaspulse/v1/rpc-health`, `GET /gaspulse/v1/gas?chain=base`, `POST /gaspulse/v1/simulate` (Standalone: `/v1/rpc-health`, `/v1/gas`, `/v1/simulate`)
- **Remote Streamable HTTP MCP:** `POST /mcp` exposing `estimate_gas`, `simulate_transaction`, `check_rpc_health` (see [MCP Suite README](../mcp-suite/README.md))
- **x402 Settlement:** `$0.01` (`10000` units) Base Mainnet USDC (`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`) to receive-only treasury `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`
- **Unified Gateway B2B Key:** Self-serve KYB onboarding via `POST /v1/kyb-checkout` + `POST /v1/verify-invoice` issues an instant stateless `ve_live_...` `X-Api-Key` (Starter `$49/mo`, Growth `$199/mo`, Enterprise `$499/mo` across all 3 APIs; standalone GasPulse tiers `$79`/`$149`/`$299`)
- **Product Reference:** [GasPulse README](../../products/gaspulse/README.md)

---

## Architecture & Footprint Profile

| Metric | Value | Notes |
|---|---|---|
| Runtime Dependencies | `0` | Pure ESM (`src/app.mjs` has zero `node:*` imports) |
| Edge / Worker Memory | `~30.8 MB` RSS (`~4.6 MB` heap) | Measured on Worker module load; bounded 10k replay cache |
| Failover Topology | `3` RPCs per chain | EWMA latency routing, block-lag check, circuit breaker |
| Deterministic Revert Handling | Isolated from node faults | Code `3` / `execution reverted` never trips RPC breakers |
| Deterministic Test Suite | `18 / 18` passing (~545 ms) | Covers failover, EIP-1559 math, revert decoder, HTTP/Worker/MCP |

---

## 1. cURL (Unified Gateway Gas Telemetry, Simulation & Remote MCP)

```bash
# Public multi-chain RPC latency & circuit-breaker snapshot via Gateway
curl -s "https://venture-engine.workers.dev/gaspulse/v1/rpc-health?probe=true&chain=base"

# Paid EIP-1559 gas estimator (returns HTTP 402 without X-Api-Key or X-Payment-Tx)
curl -s "https://venture-engine.workers.dev/gaspulse/v1/gas?chain=base" \
  -H "X-Payment-Tx: 0x<CONFIRMED_BASE_USDC_TX_HASH>"

# Paid pre-flight eth_call + eth_estimateGas + Mempool Guard check using stateless ve_live_... key
curl -s -X POST "https://venture-engine.workers.dev/gaspulse/v1/simulate" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <YOUR_STATELESS_VE_LIVE_API_KEY>" \
  -d '{
    "chain": "base",
    "from": "0x1111111111111111111111111111111111111111",
    "to": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "data": "0x",
    "value": "0"
  }'

# Or call remote Streamable HTTP MCP (POST /mcp) with estimate_gas / simulate_transaction
curl -s -X POST "https://venture-engine.workers.dev/mcp" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <YOUR_STATELESS_VE_LIVE_API_KEY>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"estimate_gas","arguments":{"chain":"base"}}}'
```

## 2. Node.js (`fetch`, Zero Dependencies)

```js
const GATEWAY_URL = "https://venture-engine.workers.dev";

const resp = await fetch(`${GATEWAY_URL}/gaspulse/v1/simulate`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Api-Key": process.env.VE_API_KEY || ""
  },
  body: JSON.stringify({
    chain: "base",
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    data: "0x",
    value: "1000000000000000"
  })
});

if (resp.status === 402) {
  const challenge = await resp.json();
  console.log("x402 payTo:", challenge.accepts[0].payTo, "amount:", challenge.accepts[0].maxAmountRequired);
} else {
  const { simulation } = await resp.json();
  if (simulation.verdict === "REVERT" || simulation.verdict === "BLOCK") {
    throw new Error(`Aborted before broadcast: ${simulation.verdict} (${simulation.revertReason || simulation.reason})`);
  }
  console.log("Safe gas limit (+20% buffer):", simulation.recommendedGasLimit);
  console.log("Fast maxFeePerGas (Gwei):", simulation.gasTiers.fast.maxFeePerGasGwei);
}
```

## 3. Python (`urllib.request`, Stdlib Only)

```python
import json
import os
import urllib.request

payload = json.dumps({
    "chain": "arbitrum",
    "from": "0x1111111111111111111111111111111111111111",
    "to": "0x2222222222222222222222222222222222222222",
    "data": "0x",
}).encode("utf-8")

req = urllib.request.Request(
    "https://venture-engine.workers.dev/gaspulse/v1/simulate",
    data=payload,
    headers={
        "Content-Type": "application/json",
        "X-Api-Key": os.environ.get("VE_API_KEY", ""),
    },
    method="POST",
)

with urllib.request.urlopen(req, timeout=10) as resp:
    result = json.loads(resp.read().decode("utf-8"))["simulation"]
    print("Verdict:", result["verdict"], "Risk:", result["mempoolGuard"]["riskLevel"])
```

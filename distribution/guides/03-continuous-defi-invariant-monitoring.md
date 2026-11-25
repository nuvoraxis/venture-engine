# Quickstart 03: Continuous DeFi Invariant & Proxy Risk Monitoring (AuditPulse)

Continuously monitor smart contracts, ERC-20 tokens, Uniswap V2/V3 pools, and ERC-4626 vaults for proxy upgrades, admin takeovers, dangerous opcodes, and reserve/TVL drain alerts across **Base**, **Ethereum**, and **Arbitrum**.

- **Unified Gateway Endpoints:** `GET|POST /auditpulse/v1/inspect`, `POST /auditpulse/v1/diff` (Standalone: `/v1/inspect`, `/v1/diff`)
- **Remote Streamable HTTP MCP:** `POST /mcp` exposing `inspect_contract_invariants`, `diff_contract_snapshots`, `verify_x402_payment` (see [MCP Suite README](../mcp-suite/README.md))
- **x402 Settlement:** `$0.02` (`20000` units) for `/auditpulse/v1/inspect` and `$0.01` (`10000` units) for `/auditpulse/v1/diff` in Base Mainnet USDC (`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`) to receive-only treasury `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`
- **Unified Gateway B2B Key:** Self-serve KYB onboarding via `POST /v1/kyb-checkout` + `POST /v1/verify-invoice` issues an instant stateless `ve_live_...` `X-Api-Key` (Starter `$49/mo`, Growth `$199/mo`, Enterprise `$499/mo` suite access; standalone AuditPulse tiers `$149`/`$299`/`$499`)
- **Product Reference:** [AuditPulse README](../../products/auditpulse/README.md)

---

## Architecture & Inspection Coverage

| Metric | Value | Notes |
|---|---|---|
| Runtime Dependencies | `0` | Shared Web Fetch handler (`src/handler.mjs`), `<10 MB` JS heap |
| Proxy & Admin Slots | EIP-1967, EIP-1822, OZ | Plus `owner()`, `admin()`, `pendingOwner()`, `paused()` |
| Bytecode Scanner | Push-aware EVM scanner | Avoids false positives inside `PUSH1..PUSH32` immediate data |
| Reserve Invariants | ERC-20, Uni V2/V3, ERC-4626 | Cross-checks `getReserves()` / `totalAssets()` vs live `balanceOf()` |
| Alert Formatters | `generic`, `slack`, `discord` | Exact `BigInt` basis-point reserve & supply delta calculation |
| Deterministic Test Suite | `10 / 10` passing (~569 ms) | Local mocked RPC verification in `products/auditpulse` |

---

## 1. cURL (Unified Gateway Invariants + Diff Webhook + Remote MCP)

```bash
# Inspect an ERC-20 / pool contract via Gateway ($0.02 Base USDC x402 or stateless ve_live_... X-Api-Key)
curl -s "https://venture-engine-gateway.leonid-ai-global.workers.dev/auditpulse/v1/inspect?address=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&chain=base" \
  -H "X-Payment-Tx: 0x<CONFIRMED_BASE_USDC_TX_HASH>"

# Compute live diff against baseline snapshot and format Slack alert ($0.01 Base USDC or X-Api-Key)
curl -s -X POST "https://venture-engine-gateway.leonid-ai-global.workers.dev/auditpulse/v1/diff" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <YOUR_STATELESS_VE_LIVE_API_KEY>" \
  -d '{
    "previous": {
      "address": "0x2222222222222222222222222222222222222222",
      "chain": "base",
      "riskScore": 10,
      "verdict": "ALLOW"
    },
    "format": "slack",
    "options": { "reserveDropPctThreshold": 5 }
  }'

# Or call remote Streamable HTTP MCP (POST /mcp) with inspect_contract_invariants
curl -s -X POST "https://venture-engine-gateway.leonid-ai-global.workers.dev/mcp" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <YOUR_STATELESS_VE_LIVE_API_KEY>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"inspect_contract_invariants","arguments":{"address":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","chain":"base"}}}'
```

## 2. Node.js (`fetch`, Zero Dependencies)

```js
const GATEWAY_URL = "https://venture-engine-gateway.leonid-ai-global.workers.dev";
const targetContract = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const inspectRes = await fetch(
  `${GATEWAY_URL}/auditpulse/v1/inspect?address=${targetContract}&chain=base`,
  { headers: { "X-Api-Key": process.env.VE_API_KEY || "" } }
);

if (inspectRes.status === 402) {
  const challenge = await inspectRes.json();
  console.log("x402 payTo:", challenge.accepts[0].payTo, "units:", challenge.accepts[0].maxAmountRequired);
} else {
  const { report } = await inspectRes.json();
  console.log("Verdict:", report.verdict, "Risk Score:", report.riskScore, "Signals:", report.flags.length);
}
```

## 3. Python (`urllib.request`, Stdlib Only)

```python
import json
import os
import urllib.request

url = "https://venture-engine-gateway.leonid-ai-global.workers.dev/auditpulse/v1/inspect?address=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&chain=base"
req = urllib.request.Request(url, headers={"X-Api-Key": os.environ.get("VE_API_KEY", "")})

with urllib.request.urlopen(req, timeout=15) as resp:
    report = json.loads(resp.read().decode("utf-8"))["report"]
    print("Address:", report["address"], "Verdict:", report["verdict"], "ERC20:", report.get("erc20"))
```

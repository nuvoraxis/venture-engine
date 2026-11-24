# Quickstart 01: x402 Autonomous Agent AML & Proxy Guard (AegisGate)

Prevent AI agents and Web3 payment flows from interacting with OFAC-sanctioned addresses, mixers, or unverified upgradeable proxies across **Base**, **Ethereum**, and **Arbitrum**.

- **Unified Gateway Endpoint:** `GET /aegis/v1/screen?address=0x...&chain=base` (Standalone: `GET /v1/screen`)
- **Remote Streamable HTTP MCP:** `POST /mcp` calling tool `screen_evm_address` (see [MCP Suite README](../mcp-suite/README.md))
- **x402 Settlement:** `$0.01` (`10000` units) Base Mainnet USDC (`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`) to receive-only treasury `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`
- **Self-Serve B2B API Key:** Submit KYB + Base USDC payment to `POST /v1/kyb-checkout` / `POST /v1/verify-invoice` (Starter `$49/mo`, Growth `$199/mo`, Enterprise `$499/mo`) to receive an instant stateless `X-Api-Key` (`ve_live_...`)
- **OpenAPI Spec:** [AegisGate OpenAPI 3.1](../../products/aegisgate/public/openapi.json)

---

## Architecture & Performance Profile

| Metric | Value | Notes |
|---|---|---|
| Runtime Dependencies | `0` | Pure Node.js >= 20 ESM & Cloudflare Workers / Vercel Edge |
| RPC Fan-Out per Screen | `4` parallel calls | `eth_getBalance`, `eth_getTransactionCount`, `eth_getCode`, `eth_getStorageAt` via `Promise.all` |
| Payment Verification | Base USDC receipt + AML | Replay-protected `eth_getTransactionReceipt` + payer screening |
| Deterministic Test Suite | `9 / 9` passing (~351 ms) | Local mocked RPC verification in `products/aegisgate` |

---

## 1. cURL (Unified Gateway: Self-Serve KYB Key, x402 & Remote MCP)

```bash
# Step 1a: Unauthenticated gateway call returns HTTP 402 with Base Mainnet USDC terms
curl -i "https://venture-engine.workers.dev/aegis/v1/screen?address=0x2222222222222222222222222222222222222222&chain=base"

# Step 1b: Or self-serve onboard via Fail-Closed KYB -> instant stateless X-Api-Key (ve_live_...)
curl -s -X POST "https://venture-engine.workers.dev/v1/kyb-checkout" \
  -H "Content-Type: application/json" \
  -d '{
    "companyName": "Acme Trading Labs Ltd",
    "jurisdiction": "AE",
    "contactDomain": "acmelabs.example",
    "payerAddress": "0x1111111111111111111111111111111111111111",
    "plan": "starter"
  }'

# Verify Base USDC settlement txHash to receive stateless apiKey ("ve_live_...")
curl -s -X POST "https://venture-engine.workers.dev/v1/verify-invoice" \
  -H "Content-Type: application/json" \
  -d '{"invoiceId":"inv_<INVOICE_ID>","txHash":"0x<CONFIRMED_BASE_USDC_TX_HASH>"}'

# Step 2a: Screen via Unified Gateway using X-Payment-Tx (x402 pay-per-call)
curl -s "https://venture-engine.workers.dev/aegis/v1/screen?address=0x2222222222222222222222222222222222222222&chain=base" \
  -H "X-Payment-Tx: 0x<CONFIRMED_BASE_USDC_TX_HASH>"

# Step 2b: Or call remote HTTP MCP (POST /mcp) with your stateless ve_live_... X-Api-Key
curl -s -X POST "https://venture-engine.workers.dev/mcp" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <YOUR_STATELESS_VE_LIVE_API_KEY>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "screen_evm_address",
      "arguments": { "address": "0x2222222222222222222222222222222222222222", "chain": "base" }
    }
  }'
```

## 2. Node.js (`fetch`, Zero Dependencies)

```js
const GATEWAY_URL = "https://venture-engine.workers.dev";
const target = "0x2222222222222222222222222222222222222222";

const res = await fetch(`${GATEWAY_URL}/aegis/v1/screen?address=${target}&chain=base`, {
  headers: {
    // Use X-Api-Key (stateless ve_live_... from /v1/verify-invoice) or X-Payment-Tx
    "X-Payment-Tx": process.env.AEGIS_PAYMENT_TX || ""
  }
});

if (res.status === 402) {
  const challenge = await res.json();
  console.log("Pay Base USDC to:", challenge.accepts[0].payTo);
  console.log("Required units:", challenge.accepts[0].maxAmountRequired);
} else {
  const { report } = await res.json();
  if (report.verdict === "BLOCK") {
    throw new Error(`Blocked address ${report.address} (score=${report.riskScore})`);
  }
  console.log("Verdict:", report.verdict, "EIP-1967 proxy:", report.isEip1967Proxy);
}
```

## 3. Python (`urllib.request`, Stdlib Only)

```python
import json
import os
import urllib.error
import urllib.request

url = "https://venture-engine.workers.dev/aegis/v1/screen?address=0x2222222222222222222222222222222222222222&chain=base"
req = urllib.request.Request(url, headers={"X-Api-Key": os.environ.get("VE_API_KEY", "")})

try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        print("Verdict:", data["report"]["verdict"], "Flags:", data["report"]["flags"])
except urllib.error.HTTPError as err:
    body = json.loads(err.read().decode("utf-8"))
    print("HTTP", err.code, body)
```

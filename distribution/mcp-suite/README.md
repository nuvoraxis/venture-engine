# Unified EVM Guard MCP & Single-URL Gateway Suite

Connect **AegisGate**, **GasPulse**, and **AuditPulse** to any AI agent over **local stdio MCP**, **remote Streamable HTTP MCP (`POST /mcp`)**, or the **Unified Single-URL Edge Gateway** with self-serve KYB onboarding (`ve_live_...` stateless `X-Api-Key`) and native **x402 Base Mainnet USDC** pay-per-call settlement.

- **Zero external dependencies** (`Node.js >= 20` ESM & Cloudflare Workers Edge)
- **Strictly read-only RPC execution** (zero private keys, zero transaction signing)
- **Single-URL Settlement:** `x402` Base Mainnet USDC (`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`) to receive-only treasury `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`, or instant stateless `ve_live_...` `X-Api-Key` issued after `POST /v1/kyb-checkout` / `POST /v1/verify-invoice`

---

## 1. Remote Streamable HTTP MCP (`POST /mcp`) â€” Unified Gateway

Deploy the unified gateway once and point any remote MCP client or autonomous agent at `POST https://<gateway-host>/mcp`:

- **`initialize` & `tools/list`:** Free discovery returning all **7 tools** (`screen_evm_address`, `estimate_gas`, `simulate_transaction`, `check_rpc_health`, `inspect_contract_invariants`, `diff_contract_snapshots`, `verify_x402_payment`).
- **`tools/call`:** Requires either `X-Api-Key` (stateless `ve_live_...` HMAC token from `/v1/kyb-checkout` or `/v1/verify-invoice`) or `X-Payment-Tx` (confirmed Base Mainnet USDC transfer >= `$0.01` to `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`); unauthenticated calls receive `HTTP 402` x402 payment terms.

```json
{
  "mcpServers": {
    "evm-guard-gateway": {
      "type": "http",
      "url": "https://venture-engine-gateway.leonid-ai-global.workers.dev/mcp",
      "headers": {
        "X-Api-Key": "<YOUR_STATELESS_VE_LIVE_API_KEY>"
      }
    }
  }
}
```

---

## 2. Local Stdio MCP Client Configuration

Run all three MCP servers locally via stdio (`node`):

```json
{
  "mcpServers": {
    "aegisgate": {
      "command": "node",
      "args": ["products/aegisgate/src/mcp_server.mjs"]
    },
    "gaspulse": {
      "command": "node",
      "args": ["products/gaspulse/src/mcp_server.mjs"]
    },
    "auditpulse": {
      "command": "node",
      "args": ["products/auditpulse/src/mcp_server.mjs"]
    }
  }
}
```

### Exposed MCP Tools (7 Total)

| Server | Tool Name | Purpose |
|---|---|---|
| `aegisgate` | `screen_evm_address` | OFAC/mixer screening, live balance/nonce/bytecode, EIP-1967 proxy detection |
| `gaspulse` | `estimate_gas` | Multi-chain EIP-1559 fee tiers (`slow`, `standard`, `fast`, `urgent`) & congestion |
| `gaspulse` | `simulate_transaction` | Pre-flight `eth_call` + `eth_estimateGas`, Solidity revert decoding, mempool & AML checks |
| `gaspulse` | `check_rpc_health` | Multi-RPC EWMA latency, block-height lag & circuit-breaker diagnostics |
| `auditpulse` | `inspect_contract_invariants` | Proxy/admin slots, push-aware dangerous opcodes, ERC-20 & V2/V3/ERC-4626 reserve checks |
| `auditpulse` | `diff_contract_snapshots` | Risk delta scoring + `generic`, `slack`, and `discord` webhook payload formatting |
| `auditpulse` | `verify_x402_payment` | Base Mainnet USDC Transfer receipt verifier with AML screening |

---

## 3. Unified Gateway & Standalone x402 HTTP Routes

### Self-Serve KYB Onboarding & Instant Stateless API Key (`Portal` Mounted at Root `/`)
- `GET /` Â· `GET /health` Â· `GET /v1/plans` Â· `GET /.well-known/x402.json` Â· `GET /llms.txt` Â· `GET /openapi.json`
- `POST /v1/kyb-checkout` â€” Validates `{ companyName, jurisdiction, contactDomain, payerAddress, plan }` (`starter` `$49` / `growth` `$199` / `enterprise` `$499` Base USDC) fail-closed and issues deterministic `invoiceId` (`inv_...`). Supplying `txHash` verifies Base USDC payment and returns `apiKey` (`ve_live_...`).
- `POST /v1/verify-invoice` â€” Verifies Base USDC `txHash` for an issued `invoiceId` (or stateless `plan`) and returns an instant stateless `ve_live_...` `X-Api-Key` accepted across `/aegis/*`, `/gaspulse/*`, `/auditpulse/*`, and `POST /mcp`.

### Downstream Service Routes

| Product | Gateway Route (Single-URL) | Standalone Route | x402 Base USDC Price | Spec / Reference |
|---|---|---|---|---|
| **AegisGate** | `GET /aegis/v1/screen` | `GET /v1/screen` | `$0.01` (`10000` units) | [AegisGate OpenAPI](../../products/aegisgate/public/openapi.json) |
| **GasPulse** | `GET /gaspulse/v1/gas`, `POST\|GET /gaspulse/v1/simulate`, `GET /gaspulse/v1/rpc-health` | `GET /v1/gas`, `POST\|GET /v1/simulate` | `$0.01` (`10000` units) | [GasPulse README](../../products/gaspulse/README.md) |
| **AuditPulse** | `GET\|POST /auditpulse/v1/inspect`, `POST /auditpulse/v1/diff` | `GET\|POST /v1/inspect`, `POST /v1/diff` | `$0.02` inspect / `$0.01` diff | [AuditPulse README](../../products/auditpulse/README.md) |
| **Portal KYB** | `POST /v1/kyb-checkout`, `POST /v1/verify-invoice` | `POST /v1/kyb-checkout`, `POST /v1/verify-invoice` | `$49` / `$199` / `$499` monthly | [Portal x402 Manifest](../../portal/public/.well-known/x402.json) |

All paid HTTP routes and `POST /mcp` `tools/call` return `HTTP 402` with an `x402` v1 `accepts` payload when called without `X-Api-Key` or `X-Payment-Tx`.

## 4. Quickstart Guides

- [01 â€” x402 Agent AML Guard (AegisGate)](../guides/01-x402-agent-aml-guard.md)
- [02 â€” Pre-Flight Tx Simulation & RPC Failover (GasPulse)](../guides/02-pre-flight-tx-simulation.md)
- [03 â€” Continuous DeFi Invariant Monitoring (AuditPulse)](../guides/03-continuous-defi-invariant-monitoring.md)

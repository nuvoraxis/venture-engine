# `@nuvoraxis/venture-engine-sdk` (JavaScript / Node.js ESM)

Zero-dependency client SDK for the **Venture Engine Unified Edge Gateway** (`https://venture-engine-gateway.leonid-ai-global.workers.dev`).

## Requirements
- Node.js >= 20.0.0 (uses native `fetch` and `AbortController`; zero npm dependencies).

## Quick Start

```js
import { VentureEngineClient, VentureEngineError } from "@nuvoraxis/venture-engine-sdk";

const client = new VentureEngineClient({
  apiKey: process.env.VE_API_KEY // or pass paymentTx for x402 Base Mainnet USDC pay-per-call
});

// 1. Screen an EVM address (AegisGate)
const screen = await client.screenAddress("0x2222222222222222222222222222222222222222", { chain: "base" });
console.log(screen.report.verdict);

// 2. Estimate EIP-1559 gas & simulate transaction (GasPulse)
const gas = await client.estimateGas("base");
const sim = await client.simulateTransaction({
  chain: "base",
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  data: "0x"
});

// 3. Inspect smart-contract & pool invariants (AuditPulse)
const inspection = await client.inspectContract("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", { chain: "base" });

// 4. Remote HTTP MCP tool call (POST /mcp)
const mcpRes = await client.callMcpTool("estimate_gas", { chain: "arbitrum" });
```

## Self-Serve x402 & KYB Onboarding
- Receive-only Base Mainnet USDC treasury: `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`
- Base Mainnet USDC asset: `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
- Unauthenticated paid requests throw `VentureEngineError` with `err.status === 402` and `err.body.accepts` payment terms.
- Use `client.kybCheckout(...)` + `client.verifyInvoice(...)` to receive a stateless `ve_live_...` API key.

## Test
```bash
npm test
```

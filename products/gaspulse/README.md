# GasPulse & Mempool Guard

Zero-dependency, low-memory (~31 MB RSS in Worker/MCP mode, <10 MB JS heap) multi-chain EVM RPC failover, EIP-1559 gas estimator, and pre-flight transaction simulation API + MCP server with native **x402 Base USDC** pay-per-call settlement and verified **B2B API key** auth.

## Capabilities
- **Multi-Chain RPC Latency & Health Failover (`Base`, `Ethereum`, `Arbitrum`)**: Tracks EWMA latency, block-height lag, and circuit-breaker state across upstream JSON-RPC providers; distinguishes deterministic EVM contract reverts from upstream node/network faults.
- **EIP-1559 Gas Estimator (`GET /v1/gas`)**: Queries `eth_feeHistory` (with `eth_gasPrice` / `eth_maxPriorityFeePerGas` fallback) to compute `slow`, `standard`, `fast`, and `urgent` fee tiers, base-fee trend, and congestion telemetry.
- **Pre-Flight Simulation & Mempool Guard (`POST /v1/simulate` or `GET /v1/simulate`)**: Runs `eth_call` + `eth_estimateGas` + sender native balance verification, decodes Solidity `Error(string)` and `Panic(uint256)` revert payloads, detects underpriced `maxFeePerGas` / overpay tips / public-mempool swap exposure, and blocks OFAC/mixer targets fail-closed.
- **Native x402 Base USDC Settlement + B2B KYB Keys**: $0.01 USDC per call (`10000` units, 6 decimals) on Base Mainnet to receive-only treasury `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`, with replay protection and AML payer screening.
- **Stdio MCP Server (`src/mcp_server.mjs`)**: Exposes `estimate_gas`, `simulate_transaction`, and `check_rpc_health` tools over JSON-RPC 2.0.
- **Cloudflare Worker Ready (`src/worker.mjs`)**: Shares the exact same core handler (`src/app.mjs`) with zero Node.js built-ins in the edge bundle.

## Endpoints
| Method & Path | Auth | Purpose |
|---|---|---|
| `GET /health` | Public | Service health, supported chains, receive-only treasury |
| `GET /v1/pricing` | Public | x402 per-call pricing (`$0.01` USDC) & B2B monthly plans (`$79`–`$299/mo`) |
| `GET /v1/rpc-health` | Public | Cached or live (`?probe=true`) RPC latency, block lag & circuit status |
| `GET /v1/gas?chain=base` | `X-Payment-Tx` or `X-Api-Key` | EIP-1559 gas tiers, congestion level & RPC telemetry |
| `POST /v1/simulate` | `X-Payment-Tx` or `X-Api-Key` | Pre-flight `eth_call` / `eth_estimateGas` + mempool guard |

## Quick Start
```bash
npm test
npm start
npm run mcp
```

### Example Simulation Request
```bash
curl -X POST http://127.0.0.1:8788/v1/simulate \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <verified-b2b-api-key>" \
  -d '{"chain":"base","from":"0x1111111111111111111111111111111111111111","to":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","data":"0x"}'
```

### x402 Pay-Per-Call Flow
1. Request `/v1/gas` or `/v1/simulate` without credentials -> receives `HTTP 402` JSON specifying Base Mainnet USDC (`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`), `10000` units ($0.01), and `payTo: 0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`.
2. Retry with `X-Payment-Tx: 0x<confirmed-base-tx-hash>`. Each transaction hash is verified on-chain via Base `eth_getTransactionReceipt`, screened against OFAC/mixer lists, and consumed once (replay-protected).

## Security & Compliance
- Strictly **read-only** RPC simulation (`eth_call`, `eth_estimateGas`, `eth_feeHistory`, `eth_getBalance`, `eth_getTransactionReceipt`); zero private keys, mnemonics, or transaction signing capabilities.
- Fail-closed AML/OFAC screening on x402 payers and simulated `from`/`to` addresses.
- B2B API keys require completed KYB/KYC verification before issuance.

# AuditPulse — Continuous Smart-Contract & Pool Invariant Risk Monitor

Zero-dependency, low-memory (<10 MB JS heap) Node.js ESM and Cloudflare Workers risk monitor for smart contracts, ERC-20 tokens, DEX pools, and ERC-4626 vaults, with **x402 Base USDC** pay-per-call settlement and stdio **MCP server**.

## Key Capabilities

1. **Contract & Pool Invariant Inspector (`GET|POST /v1/inspect`)**
   - Live JSON-RPC bytecode analysis: push-aware EVM opcode scanning (`SELFDESTRUCT`, `DELEGATECALL`, `CALLCODE`, `CREATE2`), EIP-1167 minimal proxy decoding, and SHA-256 bytecode fingerprinting.
   - Proxy & admin slot inspection: EIP-1967 implementation/admin/beacon slots, EIP-1822 `PROXIABLE`, legacy OZ proxy slot, `owner()`, `admin()`, `pendingOwner()`, `paused()`, and EOA-admin detection.
   - ERC-20 sanity checks: `totalSupply()`, `decimals()`, `symbol()`, and `name()` (including legacy `bytes32` strings), flagging zero supply, overflow supply, or abnormal decimals.
   - Reserve & pool invariant cross-checks: Uniswap V2 `getReserves()` vs live `balanceOf(pool)` checks (`POOL_RESERVE_UNDERCOLLATERALIZED` / `POOL_RESERVE_UNSYNCED_SURPLUS`), Uniswap V3 active `liquidity()`, ERC-4626 `totalAssets()` vs underlying balance, and custom watch-token balance snapshots.
2. **Risk Diff & Webhook Alert Formatter (`POST /v1/diff`)**
   - Compares a baseline inspection snapshot against either a provided `current` snapshot or a fresh live JSON-RPC inspection.
   - Detects bytecode mutations, proxy upgrades, admin takeovers, pause events, extreme supply mint/burn events, and reserve/TVL/constant-product `k` drops using exact `BigInt` basis-point arithmetic.
   - Formats alerts as `generic` JSON (`auditpulse.risk_diff.v1`), `slack` Block Kit, or `discord` embeds.
3. **x402 Base USDC & B2B API Key Auth**
   - Receive-only Base Mainnet USDC verification to `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c` (`$0.02` per `/v1/inspect`, `$0.01` per `/v1/diff`) with replay protection and OFAC/AML payer screening.
   - B2B `X-Api-Key` header authentication (`AUDITPULSE_API_KEYS`).
4. **Stdio MCP Server (`src/mcp_server.mjs`)**
   - Exposes `inspect_contract_invariants`, `diff_contract_snapshots`, and `verify_x402_payment`.

## Endpoints

- `GET /` — Service manifest & supported chains (`base`, `ethereum`, `arbitrum`)
- `GET /health` — Health & receive-only treasury status
- `GET /v1/pricing` — x402 per-call pricing & B2B monthly tiers (`$149`, `$299`, `$499` USDC/mo)
- `GET|POST /v1/inspect?address=0x...&chain=base&tokens=0x...,0x...` — Inspect contract/ERC-20/pool invariants (`X-Payment-Tx` or `X-Api-Key`)
- `POST /v1/diff` — Compute risk diff and webhook alert payload (`X-Payment-Tx` or `X-Api-Key`)

## Local Run & Test

```bash
npm test
npm start
npm run mcp
```

See [DEPLOY.md](./DEPLOY.md) for Cloudflare Workers deployment and MCP client configuration.

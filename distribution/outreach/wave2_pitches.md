# Wave 2 B2B Outreach Pitches (High-Ticket Pro & Audit Pack + x402 Self-Serve)

Target database: `distribution/outreach/target_projects_wave2.json` (30 active EVM / x402 / AI Agent repositories).

## Core Offer Anchor
1. **Free 30-Second Integration:** `POST https://venture-engine-gateway.leonid-ai-global.workers.dev/mcp` (free `initialize` & `tools/list`) or `npx -y @nuvoraxis/venture-engine-sdk`
2. **Pay-As-You-Go x402:** `$0.01 USDC` per AML screen / gas simulation / invariant check on Base Mainnet
3. **B2B Pro Tier (`$399/mo`):** Higher rate limits, batch AML screening (up to 20 addresses/call), multi-RPC failover, webhook alerts
4. **AML + Invariant Audit Pack (`$1,500` flat):** One-time pre-launch or pre-listing compliance + smart-contract invariant verification report

---

## Personalized Pitch Templates (Posted to Open GitHub Discussions)

### 1. `nuanu-ai/agent-payment-node`
**Title:** Pre-settlement AML/OFAC & Gas Simulation MCP for `agent-payment-node` (Base USDC x402)
**Body:**
Hi team! Great work on `agent-payment-node` for autonomous agent payments.
If your agents settle on Base/Ethereum/Arbitrum, we built **Venture Engine EVM Guard** (`@nuvoraxis/venture-engine-sdk`) — a zero-dependency MCP & x402 REST suite that lets payment nodes run pre-flight **OFAC/AML address screening**, **EIP-1559 gas/tx simulation**, and **RPC failover health checks** before signing.
- **Try free in 30s:** `npx -y @nuvoraxis/venture-engine-sdk` or `POST https://venture-engine-gateway.leonid-ai-global.workers.dev/mcp`
- **Pricing:** `$0.01 USDC` per call via x402 on Base, or self-serve B2B Pro (`$399/mo`) / AML + Invariant Audit Pack (`$1,500` flat) via `GET /v1/plans`.
Happy to share integration examples if useful!

### 2. `MikeyPetrillo/Agent402`
**Title:** Adding AegisGate AML Screening & GasPulse Failover to Agent402 x402 Workflows
**Body:**
Hi! Really like the `Agent402` approach to x402 agent workflows.
We just shipped **Venture Engine EVM Guard** (live x402 + Streamable HTTP MCP gateway + npm/PyPI SDKs) covering:
1. **AegisGate (`aegis_screen_evm_address` / `batch_screen_evm_addresses`)** — real-time OFAC/AML & proxy risk screening on Base, Ethereum, Arbitrum.
2. **GasPulse (`gaspulse_estimate_gas` / `gaspulse_simulate_tx`)** — multi-RPC failover and EIP-1559 fee estimation.
3. **AuditPulse (`auditpulse_inspect_contract`)** — bytecode & vault/DEX invariant checks.
- **Live MCP:** `https://venture-engine-gateway.leonid-ai-global.workers.dev/mcp` (`tools/list` is free)
- **SDKs:** `npm i @nuvoraxis/venture-engine-sdk` | `pip install venture-engine-sdk`
- **B2B Plans:** x402 pay-per-call (`$0.01 USDC`), Pro (`$399/mo`), or Pre-Launch Audit Pack (`$1,500`).

### 3. `nirholas/universal-crypto-mcp`
**Title:** Integration idea: x402-ready EVM AML Screening & Contract Invariant Tools (`venture-engine`)
**Body:**
Awesome collection in `universal-crypto-mcp`!
If you are looking for ready-to-plug **AML/OFAC screening**, **multi-chain EIP-1559 tx simulation**, and **contract invariant monitoring** across Base, Ethereum, and Arbitrum, we published **Venture Engine EVM Guard**:
- **Zero-dependency stdio & Streamable HTTP MCP:** `npx -y @nuvoraxis/venture-engine-sdk` | `https://venture-engine-gateway.leonid-ai-global.workers.dev/mcp`
- **x402 Native + B2B Pro (`$399/mo`) / Audit Pack (`$1,500`):** `https://github.com/nuvoraxis/venture-engine`
Would love to collaborate or add a connector template!

### 4. `omermaksutii/RugProof`
**Title:** Complementing RugProof with Live OFAC/AML Screening & Invariant Diffing via MCP/x402
**Body:**
Great focus on on-chain safety in `RugProof`!
We built **Venture Engine EVM Guard** (`https://github.com/nuvoraxis/venture-engine`) with 8 MCP tools and REST endpoints (`AegisGate` AML/OFAC screening, `GasPulse` tx simulation, `AuditPulse` bytecode & DEX/vault invariant diffing) on Base, Ethereum, and Arbitrum.
- **30-second test:** `curl -sS "https://venture-engine-gateway.leonid-ai-global.workers.dev/gaspulse/v1/gas?chain=base"`
- **Self-serve B2B:** x402 `$0.01 USDC`/call, Pro `$399/mo`, or `$1,500` AML + Invariant Audit Pack.

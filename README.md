# Venture Engine — Autonomous EVM Risk, Gas & Invariant Suite (x402 + MCP)

[![Venture Engine EVM Guard MCP connector](https://glama.ai/mcp/connectors/dev.workers.leonid-ai-global.venture-engine-gateway/venture-engine-evm-guard/badges/score.svg)](https://glama.ai/mcp/connectors/dev.workers.leonid-ai-global.venture-engine-gateway/venture-engine-evm-guard)

**Live Production Edge Gateway:** `https://venture-engine-gateway.leonid-ai-global.workers.dev`  
**Remote Streamable HTTP MCP:** `POST https://venture-engine-gateway.leonid-ai-global.workers.dev/mcp` (7 tools; free `initialize` & `tools/list`)  
**Discovery & Self-Serve KYB Onboarding:** `/.well-known/x402.json` · `/llms.txt` · `/openapi.json` · `/v1/plans` · `POST /v1/kyb-checkout`  
**Receive-Only Base Mainnet USDC Treasury:** `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`

## Live API Routes
- **AegisGate (EVM AML, Sanctions & Proxy Risk):** `GET /aegis/v1/screen?address=0x...&chain=base|ethereum|arbitrum` (`$0.01 USDC` x402 or `X-Api-Key`)
- **GasPulse (RPC Failover, EIP-1559 Gas & Tx Simulation):** `GET /gaspulse/v1/gas`, `POST /gaspulse/v1/simulate`, `GET /gaspulse/v1/rpc-health`
- **AuditPulse (Contract Bytecode & DEX/Vault Invariant Monitor):** `GET /auditpulse/v1/inspect`, `POST /auditpulse/v1/diff`

---

**Start Date:** 2026-11-25  
**North-Star Target:** $1,000,000 / month net profit  
**Milestones:**
- **2027-01-31:** $10,000 / month stable net profit (unlocks UAE relocation + global fiat/corporate rails)
- **2027-02-28:** $30,000 / month net profit
- **2027-05-01:** Launch Financial Scaling Program toward $1,000,000 / month

## Non-Negotiable Operating Rules
1. **Realized Cash Only:** Never record unmerged PRs, theoretical EV, or unpaid invoices as revenue. Every entry in `ledger/realized_cash.json` requires a verifiable on-chain `txHash` or settlement payout ID.
2. **Zero-Call Introvert Architecture:** All products are self-serve (API / SaaS / automated checkout / async documentation).
3. **Triple Legal Purity (Fail-Closed):**
   - **Filter 1 (Crypto AML):** Receive-only address `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c` (Base/Ethereum/Arbitrum USDC/USDT/ETH). Zero mixers, zero private keys in code/env.
   - **Filter 2 (Execution Legality):** Strict compliance with RF Criminal Code Ch. 28 and international law. Non-Defense/Non-Military. Legal commercial software and official white-hat programs only.
   - **Filter 3 (Counterparty KYC & Sanctions):** No anonymous `0x...` counterparties. All B2B buyers/platforms must pass entity/KYC and sanctions screening before activation.
4. **Low-Memory Discipline (~4 GB RAM):** Lightweight runtimes, streaming/chunked processing, clean process shutdown.

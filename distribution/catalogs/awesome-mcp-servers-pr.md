# Pull Request Draft: `awesome-mcp-servers` & Community MCP Directories

Use this ready-to-submit copy when opening PRs to `punkpeye/awesome-mcp-servers`, `modelcontextprotocol/servers` community lists, Smithery, or Glama.

---

## Suggested Category
- **Finance / Crypto / Web3 Security & Infrastructure**

## Ready-to-Paste Table Entries

```markdown
- [EVM Guard Unified MCP Gateway](https://github.com/nuvoraxis/venture-engine/tree/main/gateway) - Single-URL Cloudflare Workers remote Streamable HTTP MCP (`POST /mcp`, 7 tools) + self-serve KYB (`POST /v1/kyb-checkout`, `POST /v1/verify-invoice`) and x402 Base USDC routing across AegisGate (`/aegis/v1/screen`), GasPulse (`/gaspulse/v1/gas`, `/gaspulse/v1/simulate`), and AuditPulse (`/auditpulse/v1/inspect`, `/auditpulse/v1/diff`).
- [AegisGate](https://github.com/nuvoraxis/venture-engine/tree/main/products/aegisgate) - Real-time EVM wallet OFAC/mixer AML screening and EIP-1967 upgradeable proxy detector across Base, Ethereum, and Arbitrum (zero-dependency Node ESM + x402 HTTP).
- [GasPulse](https://github.com/nuvoraxis/venture-engine/tree/main/products/gaspulse) - Multi-chain EVM RPC latency/circuit-breaker failover, EIP-1559 gas estimator, and pre-flight `eth_call`/`eth_estimateGas` transaction simulator with Solidity revert decoding.
- [AuditPulse](https://github.com/nuvoraxis/venture-engine/tree/main/products/auditpulse) - Smart-contract bytecode/proxy risk inspector, Uniswap V2/V3 and ERC-4626 reserve invariant checker, and Slack/Discord risk-diff alert formatter.
```

## PR Description Template

```markdown
### Add EVM Guard MCP Suite & Unified HTTP Gateway (AegisGate, GasPulse, AuditPulse)

Adds three zero-dependency Node.js >= 20 ESM stdio MCP servers plus a single-origin Cloudflare Workers edge gateway (`POST /mcp` remote Streamable HTTP MCP + prefixed REST APIs + self-serve KYB onboarding) focused on autonomous agent transaction safety across Base, Ethereum, and Arbitrum:

1. **AegisGate** (`screen_evm_address` / `/aegis/v1/screen`): OFAC SDN / mixer screening, live balance/nonce/code inspection, EIP-1967 proxy slot verification.
2. **GasPulse** (`estimate_gas`, `simulate_transaction`, `check_rpc_health` / `/gaspulse/v1/gas`, `/gaspulse/v1/simulate`): EWMA latency-routed JSON-RPC failover, EIP-1559 tiers, pre-flight revert decoding, and mempool/balance safety checks.
3. **AuditPulse** (`inspect_contract_invariants`, `diff_contract_snapshots`, `verify_x402_payment` / `/auditpulse/v1/inspect`, `/auditpulse/v1/diff`): Proxy/admin slot analysis, push-aware opcode risk scanning, DEX/vault reserve cross-checks, and alert formatting.
4. **Unified Remote MCP & KYB Auth** (`POST /mcp`, `POST /v1/kyb-checkout`, `POST /v1/verify-invoice`): Free `initialize` & `tools/list`; `tools/call` accepts `X-Payment-Tx` (x402 Base USDC to receive-only `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`) or stateless HMAC `X-Api-Key` (`ve_live_...`).

#### Verification & Safety Properties
- Zero external npm dependencies; runs on standard Node.js >= 20 built-ins and pure Web APIs.
- Strictly read-only JSON-RPC inspection/simulation; zero private keys or transaction signing.
- MIT licensed with automated `node --test` suites in every package.
```

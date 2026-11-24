# Venture Engine Unified Single-URL Edge Gateway

Zero-dependency, low-memory (<40 MB RAM) Web-Standard ESM Edge Gateway combining the **B2B KYB Portal**, **AegisGate**, **GasPulse**, **AuditPulse**, stateless **HMAC-SHA256 B2B API Tokens**, and a remote **Streamable HTTP JSON-RPC 2.0 MCP Server** on a single Cloudflare Worker origin.

## Route Map
- **Portal & AI Discovery:**
  - `GET /`, `GET /health`, `GET /v1/plans`, `GET /.well-known/x402.json`, `GET /llms.txt`, `GET /openapi.json`
  - `POST /v1/kyb-checkout` & `POST /v1/verify-invoice` — Fail-Closed KYB + Base Mainnet USDC (`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`) verification to receive-only treasury `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`. On `PAID_AND_VERIFIED` (when `VE_TOKEN_SECRET` is configured), issues an instant stateless `apiKey` (`ve_live_<payload>.<sig>`, 30-day TTL).
- **Mounted Product APIs (prefix stripped before dispatch):**
  - `/aegis/*` -> AegisGate (`GET /aegis/health`, `GET /aegis/v1/screen`, etc.)
  - `/gaspulse/*` -> GasPulse (`GET /gaspulse/health`, `GET /gaspulse/v1/gas`, `POST /gaspulse/v1/simulate`, `GET /gaspulse/v1/rpc-health`)
  - `/auditpulse/*` -> AuditPulse (`GET /auditpulse/health`, `GET|POST /auditpulse/v1/inspect`, `POST /auditpulse/v1/diff`)
- **Remote Streamable HTTP MCP (`POST /mcp`):**
  - Free discovery: `initialize`, `tools/list`, `ping`, `notifications/initialized`
  - Paid/authorized execution (`tools/call` requiring `X-Api-Key` or Base USDC `X-Payment-Tx`):
    1. `screen_evm_address`
    2. `estimate_gas`
    3. `simulate_transaction`
    4. `check_rpc_health`
    5. `inspect_contract_invariants`
    6. `diff_contract_snapshots`
    7. `verify_x402_payment`

## Stateless Token Security (`src/auth_tokens.mjs`)
- Pure `crypto.subtle` HMAC-SHA256 (`ve_live_<base64url(payload)>.<base64url(sig)>`) with constant-time signature verification and Fail-Closed rejection if `VE_TOKEN_SECRET` is unset, tampered, or expired.
- Zero private keys or hardcoded secrets on disk.

## Architecture
- `src/auth_tokens.mjs` — Pure Web Crypto HMAC-SHA256 token issuer & constant-time verifier (zero `node:*` imports)
- `src/mcp_http.mjs` — Remote HTTP JSON-RPC 2.0 `POST /mcp` handler exposing all 7 suite tools (zero `node:*` imports)
- `src/gateway.mjs` — Unified Web Fetch router & cross-mount auth/replay coordinator (zero `node:*` imports)
- `src/worker.mjs` + `wrangler.toml` — Cloudflare Workers entrypoint (`../portal/public` assets binding)
- `src/server.mjs` — Loopback (`127.0.0.1`) Node.js HTTP server adapter
- `tests/gateway.test.mjs` — Comprehensive unit, auth, MCP, Worker, Node HTTP, and hygiene tests

## Run, Test & Deploy
```bash
npm test
npm start
npx wrangler secret put VE_TOKEN_SECRET
npx wrangler deploy
```

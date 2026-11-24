# Venture Engine Portal — Self-Serve B2B Onboarding, Fail-Closed KYB Gate & AI Discovery Layer

Zero-dependency, low-memory (<40 MB RAM) B2B onboarding portal and AI agent discovery hub for the **Venture Engine** 3-API suite (**AegisGate**, **GasPulse**, and **AuditPulse**). Built on pure Web Standard Fetch APIs for Cloudflare Workers (`wrangler.toml` + `src/worker.mjs`) and Node.js (`src/server.mjs`).

## Self-Serve Monthly B2B Plans (Base Mainnet USDC)
All B2B settlements and x402 payments route strictly to the receive-only treasury **`0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`** (Base USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, chainId `8453`):

| Plan | Monthly Price | Base USDC Units | Monthly Quota | Included APIs |
| --- | --- | --- | --- | --- |
| `starter` | `$49 / mo` | `49000000` | `25,000` calls | AegisGate, GasPulse, AuditPulse |
| `growth` | `$199 / mo` | `199000000` | `150,000` calls | AegisGate, GasPulse, AuditPulse |
| `enterprise` | `$499 / mo` | `499000000` | `1,000,000` calls | AegisGate, GasPulse, AuditPulse |

## Endpoints
- `GET /` — Self-serve B2B portal UI & interactive KYB checkout form (`public/index.html`)
- `GET /health` — Service health & receive-only treasury status
- `GET /v1/plans` — Suite capabilities and Starter / Growth / Enterprise pricing
- `GET /.well-known/x402.json` — x402 protocol & service discovery manifest
- `GET /llms.txt` — Plain-text AI agent discovery summary
- `GET /openapi.json` — OpenAPI 3.1.0 specification
- `POST /v1/kyb-checkout` — Step 1: Fail-Closed KYB/AML validation & deterministic `inv_<24hex>` invoice issuance; Step 2 (with `txHash`): on-chain Base USDC verification
- `POST /v1/verify-invoice` — Verifies Base Mainnet USDC `Transfer` receipt to `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c` with bounded FIFO replay protection

## Fail-Closed Compliance Guarantees
- **Zero Private Keys / Signing:** Treasury is strictly receive-only; no keys, mnemonics, or transaction-signing methods exist anywhere in code or config.
- **Filter 1 (Crypto AML):** Rejects known OFAC SDN, Tornado Cash mixer, exploiter, and zero/treasury addresses both during KYB and on-chain receipt verification.
- **Filter 2 (Execution Legality):** Rejects defense, military, espionage, weapons, ransomware, and darknet requests.
- **Filter 3 (Counterparty KYB):** Rejects anonymous entities, bare `0x...` names, free consumer webmail / disposable domains, `.onion`/`.i2p` darknet TLDs, and prohibited jurisdictions.

## Architecture
- `src/kyb_gate.mjs` — Fail-Closed KYB/AML screening, deterministic Web Crypto SHA-256 invoice IDs, bounded stores, and Base USDC receipt verifier (zero `node:*` imports)
- `src/app.mjs` — Web Fetch API router shared across Workers and Node.js (zero `node:*` imports)
- `src/worker.mjs` — Cloudflare Workers fetch entrypoint
- `src/server.mjs` — Local loopback (`127.0.0.1`) Node.js HTTP server adapter
- `wrangler.toml` — Cloudflare Workers config binding `./public` static assets
- `public/` — Static HTML landing, `.well-known/x402.json`, `llms.txt`, `openapi.json`, `_headers`
- `tests/portal.test.mjs` — Unit, Worker fetch, Node HTTP, and compliance hygiene tests

## Run, Test & Deploy
```bash
npm test
npm start
npx wrangler deploy
```

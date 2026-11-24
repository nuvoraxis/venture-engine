# Operator Launch Guide (Zero-Cost Self-Serve Edge Deployment)

This checklist takes the Venture Engine suite (**AegisGate**, **GasPulse**, **AuditPulse**, and **Portal**) from verified local code to live **$0/mo serverless edge production** with **zero sales calls** and **receive-only Base USDC settlement** (`0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`).

> **Security Isolation Rules:**
> - Never expose localhost ports (`ngrok`, `cloudflared` tunnels, or port forwarding) from a personal laptop.
> - Never commit `.env` files, private keys, API keys, or local home-directory paths.
> - Keep `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c` strictly **receive-only**.

---

## Step 1: Run Sequential Pre-Flight & Live RPC Smoke Verification

From the repository root (`venture-engine/`):

```powershell
powershell -ExecutionPolicy Bypass -File ops\deploy_preflight.ps1
powershell -ExecutionPolicy Bypass -File ops\treasury_sync.ps1 -DryRun
node ops\live_smoke.mjs
```

Confirm:
- `compliance/gate.ps1` reports `0 violations`.
- All 6 packages (`products/aegisgate`, `products/gaspulse`, `products/auditpulse`, `portal`, `distribution`, `gateway`) pass `npm test` with 100% pass rate.
- `node ops/live_smoke.mjs` verifies live Base Mainnet & Ethereum RPC responses for AegisGate, GasPulse, and AuditPulse.

---

## Step 2: Initialize Git Hygiene & Push to GitHub

Pin the pseudonymous project git identity locally so commits leak zero personal emails or local names:

```bash
git init
git config user.name "nuvoraxis"
git config user.email "nuvoraxis@users.noreply.github.com"
git status
git add .
git commit -m "feat: initial release of AegisGate, GasPulse, AuditPulse, Portal & Distribution"
git branch -M main
git remote add origin https://github.com/nuvoraxis/venture-engine.git
git push -u origin main
```

---

## Step 3: Deploy Unified Edge Gateway to Cloudflare Free Tier ($0/mo)

Authenticate Wrangler once in your terminal:

```bash
npx wrangler login
```

### Primary 1-Command Unified Gateway Deploy (`gateway/`)

The `gateway/` Worker (`name = "venture-engine-gateway"`) mounts Portal (`/`, `/v1/kyb-checkout`, `/v1/verify-invoice`, `/.well-known/x402.json`, `/llms.txt`, `/openapi.json`), `/aegis/*`, `/gaspulse/*`, `/auditpulse/*`, and remote `POST /mcp` (7 tools) on a single edge URL and issues instant HMAC-signed stateless `X-Api-Key` tokens (`ve_live_...`) on verified Base USDC settlement:

```bash
cd gateway
npx wrangler secret put VE_TOKEN_SECRET
npx wrangler deploy
```

*(Recommended)* Configure `ETH_RPC_URL` (e.g. `https://ethereum-rpc.publicnode.com` or a private Alchemy/QuickNode URL) and optional static fallback keys (`VE_STATIC_API_KEYS`), `BASE_RPC_URL`, `ARB_RPC_URL` via `npx wrangler secret put <NAME>`.

### Post-Deploy Edge Smoke Checks

Verify the unified gateway responds cleanly over HTTPS and challenges unauthenticated paid routes with HTTP `402`:

```bash
curl https://venture-engine-gateway.<subdomain>.workers.dev/health
curl https://venture-engine-gateway.<subdomain>.workers.dev/.well-known/x402.json

# Confirm remote MCP tools/list works without payment and tools/call enforces x402 / X-Api-Key
curl -X POST https://venture-engine-gateway.<subdomain>.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Confirm HTTP 402 x402 payload points to 0x703d3948cc102bf4bc0ef93ef330f56be2afd69c
curl -i "https://venture-engine-gateway.<subdomain>.workers.dev/auditpulse/v1/inspect?address=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&chain=base"
```

### Optional Standalone Per-Product Worker Deploys

If you prefer isolated subdomains per microservice, deploy `products/aegisgate`, `products/gaspulse`, `products/auditpulse`, and `portal` sequentially (`npx wrangler secret put <API_KEYS_VAR>` + `npx wrangler deploy`).

*(Optional)* Replace placeholder `workers.dev` URLs in `portal/` and `distribution/` with your live deployed Gateway hostname before pushing final catalog PRs.

---

## Step 4: Zero-Budget Distribution & Catalog Submissions

Use the ready-to-submit assets inside `distribution/`:
1. **MCP Directories:** Submit `distribution/mcp-suite/smithery.yaml` to Smithery, `distribution/mcp-suite/glama.json` to Glama, and open a PR using `distribution/catalogs/awesome-mcp-servers-pr.md`.
2. **x402 Ecosystem:** Submit `distribution/catalogs/x402-directory-entry.json` and ensure `portal/public/.well-known/x402.json` and `portal/public/llms.txt` are live on your edge domain.
3. **GitHub Discovery:** Apply repository topics and badges from `distribution/catalogs/github-topics-and-badges.md`.
4. **Developer Quickstarts:** Publish the 3 guides in `distribution/guides/` alongside your repository links.

---

## Step 5: Connecting Verified B2B USDC Payments & Ledger Sync

1. **Automated x402 Pay-Per-Call:** AI agents pay `$0.01–$0.02` Base USDC directly to `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c` and pass `X-Payment-Tx: 0x...`.
2. **Self-Serve B2B Subscriptions (`$49–$499/mo`):** Customers submit entity details through `portal/` `POST /v1/kyb-checkout`, which enforces Fail-Closed sanctions/OFAC/prohibited-jurisdiction screening before issuing an invoice and verifying on-chain Base USDC payment.
3. **Verify Realized Cash On-Chain:** Run live treasury sync periodically:
   ```powershell
   powershell -ExecutionPolicy Bypass -File ops\treasury_sync.ps1
   ```
   Only entries with a verified on-chain `txHash` and `counterparty_kyc_status = "VERIFIED"` may be recorded in `ledger/realized_cash.json`.

# Deploying AegisGate (Zero-Cost Serverless Edge & Self-Serve Distribution)

AegisGate is engineered for **$0/month free-tier serverless edge hosting** with zero external npm dependencies, minimal memory overhead, and strict non-custodial compliance.

## Security & Compliance Guarantees

- **Zero Local Exposure:** Never serve public API traffic from a local machine or tunnel (`ngrok`, `cloudflared`). Deploy exclusively to isolated edge platforms.
- **Strictly Receive-Only Treasury:** All x402 Base Mainnet USDC payments and B2B plan settlements go exclusively to `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`.
- **Zero Signing Secrets:** No private keys, mnemonics, or transaction-signing capabilities exist anywhere in the codebase or environment configuration.
- **Fail-Closed Payment & AML Screening:** Every `X-Payment-Tx` receipt verifies a confirmed Base USDC transfer to the treasury and screens the payer address before returning a report.

---

## Option 1: Cloudflare Workers (Recommended — $0/mo Free Tier)

`wrangler.toml` wires `src/worker.mjs` together with static assets in `public/` (`index.html`, `openapi.json`, `_headers`).

### 1. Authenticate Wrangler (Interactive Operator Step)
Run from `products/aegisgate`:

```bash
npx wrangler login
```

### 2. Configure B2B API Keys (Optional Encrypted Secret)
Never commit API keys into `wrangler.toml` or git. Store comma-separated verified B2B keys as an encrypted Cloudflare secret:

```bash
npx wrangler secret put AEGISGATE_API_KEYS
# Enter comma-separated keys when prompted, e.g.: key_live_abc,key_live_def
```

### 3. Deploy to Cloudflare Edge

```bash
npx wrangler deploy
```

### 4. Verify Live Endpoints

```bash
curl https://<your-worker>.workers.dev/health
curl https://<your-worker>.workers.dev/v1/pricing
curl https://<your-worker>.workers.dev/openapi.json
curl -i "https://<your-worker>.workers.dev/v1/screen?address=0x8589427373d6d84e98730d7795d8f6f8731fda16&chain=base"
```

Expected behavior: `/v1/screen` without credentials returns `HTTP 402` with x402 Base Mainnet USDC settlement instructions (`payTo: 0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`, `maxAmountRequired: "10000"`).

---

## Option 2: Vercel Edge Network ($0/mo Hobby Tier)

`vercel.json` routes `/health`, `/openapi.json`, and `/v1/*` to `api/edge.mjs` (`runtime: "edge"`) while serving `public/` from the edge CDN.

1. Connect the repository in Vercel and set **Root Directory** to `products/aegisgate`.
2. Add encrypted environment variable `AEGISGATE_API_KEYS` (comma-separated) in Vercel Project Settings if issuing B2B keys.
3. Deploy via Git push or Vercel CLI (`npx vercel --prod`).

---

## Zero-Call Self-Serve Distribution & Listings

### 1. OpenAPI / x402 Agent Discovery
- Machine-readable specification: `GET /openapi.json` (OpenAPI 3.1.0).
- Interactive developer landing & self-serve explorer: `GET /`.
- Pay-per-call flow:
  1. Client calls `GET /v1/screen?address=0x...&chain=base`.
  2. Server responds `402 Payment Required` with x402 JSON (`network: "base-mainnet"`, `asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"`, `maxAmountRequired: "10000"`, `payTo: "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c"`).
  3. Client transfers >= `0.01` USDC on Base Mainnet and retries with `X-Payment-Tx: <txHash>`.
  4. Replaying a consumed `txHash` returns `402` (`TX_ALREADY_CONSUMED`).

### 2. MCP Server Distribution (`mcp.json`)
`mcp.json` declares the `screen_evm_address` stdio MCP tool and x402 payment metadata with zero local machine paths.

- For npm publication (`package.json` exposes `bin.aegisgate-mcp`):
  ```bash
  npx -y --package=aegisgate aegisgate-mcp
  ```
- Submit `mcp.json` and your live `/openapi.json` URL to MCP directories (Smithery, Glama, mcp.so) and x402 service catalogs.

### 3. B2B Monthly Plans (KYB-Verified)
- `starter`: `$49 / month` USDC
- `growth`: `$199 / month` USDC
- `enterprise`: `$499 / month` USDC
- Issue an `X-Api-Key` only after counterparty entity/KYB and sanctions checks pass, and store the key solely in encrypted edge secrets (`AEGISGATE_API_KEYS`).

---

## Pre-Deploy Verification Checklist

1. Run full test suite: `npm test` (must pass 100%).
2. Confirm no `.env`, credential files, or local file paths exist inside `products/aegisgate/`.
3. Confirm treasury address across `src/x402.mjs`, `wrangler.toml`, `public/openapi.json`, `public/index.html`, and `mcp.json` equals `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`.

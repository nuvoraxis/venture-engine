# AegisGate — EVM AML, Sanctions & Contract Risk API + MCP Server

Zero-dependency, low-memory (<30 MB RAM) B2B risk screening API with native **x402 Base USDC** pay-per-call settlement, **Cloudflare Workers / Vercel Edge** support, **OpenAPI 3.1.0**, and a stdio **MCP server**.

## Endpoints
- `GET /` — Self-serve landing page & interactive endpoint explorer (`public/index.html`)
- `GET /health` — Health, supported chains & receive-only treasury status
- `GET /v1/pricing` — x402 (`$0.01` Base USDC) & B2B monthly plans (`$49 / $199 / $499`)
- `GET /openapi.json` — OpenAPI 3.1.0 specification (`public/openapi.json`)
- `GET /v1/screen?address=0x...&chain=base` — Requires `X-Payment-Tx` (Base USDC txHash >= $0.01) or `X-Api-Key`

## Architecture
- `src/risk_engine.mjs` — OFAC/mixer check + live EVM RPC inspection (`base`, `ethereum`, `arbitrum`)
- `src/x402.mjs` — Base Mainnet USDC transfer verification & replay protection (`0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`)
- `src/app.mjs` — Shared Web-standard Request/Response router & auth handler
- `src/worker.mjs` + `wrangler.toml` — Cloudflare Workers entry + static assets
- `api/edge.mjs` + `vercel.json` — Vercel Edge Function entry
- `src/server.mjs` — Local Node.js HTTP adapter
- `src/mcp_server.mjs` + `mcp.json` — Stdio JSON-RPC 2.0 MCP server (`screen_evm_address`)

## Run, Test & Deploy
```bash
npm test
npm start
npm run mcp
```

See [DEPLOY.md](./DEPLOY.md) for zero-cost Cloudflare Workers and Vercel Edge deployment instructions.

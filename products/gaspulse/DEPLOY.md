# Deploying GasPulse & Mempool Guard

GasPulse runs natively on **Cloudflare Workers** ($0 free tier) as well as standard **Node.js >= 20** edge/container hosts. Public endpoints must be deployed to isolated external cloud/serverless infrastructure rather than exposed from a local workstation.

## 1. Cloudflare Workers Deployment

### Prerequisites
- Node.js >= 20
- Cloudflare account authenticated via Wrangler (`npx wrangler login` or CI token in secret manager)

### Configure Secrets & Optional RPC Overrides
Never place API keys or custom provider tokens in `wrangler.toml` or git history. Set secrets via Wrangler:

```bash
# Comma-separated KYB-verified B2B API keys
npx wrangler secret put GASPULSE_API_KEYS
```

Optional comma-separated RPC failover overrides can be configured as Worker variables or secrets (`BASE_RPCS`, `ETHEREUM_RPCS`, `ARBITRUM_RPCS`).

### Deploy
```bash
npx wrangler deploy
```

### Post-Deploy Smoke Checks
```bash
# 1. Verify public health & receive-only treasury
curl https://<your-worker-subdomain>.workers.dev/health

# 2. Verify x402 paywall (expects HTTP 402)
curl -i https://<your-worker-subdomain>.workers.dev/v1/gas?chain=base

# 3. Verify B2B API key auth (expects HTTP 200)
curl -H "X-Api-Key: <verified-b2b-api-key>" \
  https://<your-worker-subdomain>.workers.dev/v1/gas?chain=base
```

## 2. Node.js Container / Cloud Hosting

Environment variables:
- `PORT` (default `8788`)
- `HOST` (default `127.0.0.1`; set `0.0.0.0` inside isolated cloud containers)
- `GASPULSE_API_KEYS` (comma-separated verified B2B API keys)
- `BASE_RPCS`, `ETHEREUM_RPCS`, `ARBITRUM_RPCS` (optional comma-separated JSON-RPC URLs)

Start command:
```bash
npm start
```

## 3. Stdio MCP Server Integration

Add to an MCP-compatible client using stdio transport:

```json
{
  "mcpServers": {
    "gaspulse": {
      "command": "node",
      "args": ["src/mcp_server.mjs"]
    }
  }
}
```

Tools exposed:
- `estimate_gas` (`chain`: `base | ethereum | arbitrum`)
- `simulate_transaction` (`chain`, `from`, `to`, `data`, `value`, `gas`, `maxFeePerGas`, `maxPriorityFeePerGas`, `blockTag`)
- `check_rpc_health` (`chain` optional)

## 4. Treasury & Compliance Verification
- Receive-only treasury address: `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`
- Base Mainnet USDC contract: `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
- Per-call x402 fee: `10000` units (`$0.01` USDC)
- Zero private keys or signing capabilities exist anywhere in the runtime.

# Deploying AuditPulse

AuditPulse runs with zero external npm dependencies on **Cloudflare Workers** (free/edge tier) or **Node.js >= 20** (<10 MB JS heap).

> **Security Policy:** Never deploy public endpoints from a personal workstation IP, never commit `.env` files or API keys, and keep the treasury address strictly receive-only (`0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`).

## 1. Cloudflare Workers Deployment

```bash
# Authenticate Wrangler once in your deployment environment
npx wrangler login

# Configure B2B API keys as encrypted Worker secrets (comma-separated)
npx wrangler secret put AUDITPULSE_API_KEYS

# Optional: configure dedicated RPC endpoints for higher rate limits
npx wrangler secret put BASE_RPC_URL
npx wrangler secret put ETH_RPC_URL
npx wrangler secret put ARB_RPC_URL

# Deploy Worker
npx wrangler deploy
```

### Verify Live Worker

```bash
curl https://<your-worker-subdomain>.workers.dev/health
curl https://<your-worker-subdomain>.workers.dev/v1/pricing
```

Expected `402` x402 payment challenge on unauthenticated `/v1/inspect`:

```bash
curl -i "https://<your-worker-subdomain>.workers.dev/v1/inspect?address=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&chain=base"
```

Authenticated B2B inspection:

```bash
curl -H "X-Api-Key: <your-b2b-key>" \
  "https://<your-worker-subdomain>.workers.dev/v1/inspect?address=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&chain=base"
```

Live diff + Slack webhook alert formatting:

```bash
curl -X POST https://<your-worker-subdomain>.workers.dev/v1/diff \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: <your-b2b-key>" \
  -d '{"previous": <baseline_report>, "format": "slack"}'
```

## 2. Node.js Runtime (Container / Render / Fly)

```bash
PORT=8788 HOST=0.0.0.0 AUDITPULSE_API_KEYS="key_1,key_2" node src/server.mjs
```

## 3. Stdio MCP Client Configuration

Add AuditPulse to any MCP-compatible AI agent client:

```json
{
  "mcpServers": {
    "auditpulse": {
      "command": "node",
      "args": ["products/auditpulse/src/mcp_server.mjs"]
    }
  }
}
```

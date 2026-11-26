# Zero-Call B2B Integration Templates (x402 & EVM Agent Builders)

Target audience: Open-source x402 agent frameworks, crypto payment routers, and DeFi automation tools listed in `target_projects.json`.

## 1. 1-Line Streamable HTTP MCP Integration
Any MCP-compatible agent (`daydreams`, `ClawRouter`, Claude Desktop, Cursor) can connect immediately:

```json
{
  "mcpServers": {
    "venture-engine-evm-guard": {
      "type": "streamable-http",
      "url": "https://venture-engine-gateway.leonid-ai-global.workers.dev/mcp"
    }
  }
}
```

## 2. Stdio Proxy via `@nuvoraxis/venture-engine-sdk`
```bash
VENTURE_ENGINE_API_KEY="ve_live_..." npx @nuvoraxis/venture-engine-sdk
```

## 3. Pre-Flight AML + Tx Simulation (`x402` Base USDC)
- **Single AML Screen:** `GET https://venture-engine-gateway.leonid-ai-global.workers.dev/aegis/v1/screen?address=0x...&chain=base` (`$0.01 USDC`)
- **Batch AML Screen (up to 25 addresses):** `POST https://venture-engine-gateway.leonid-ai-global.workers.dev/aegis/v1/screen/batch` (`$0.02 USDC`)
- **Pre-Flight Tx Simulation:** `POST https://venture-engine-gateway.leonid-ai-global.workers.dev/gaspulse/v1/simulate` (`$0.01 USDC`)

## 4. Free Embeddable Live Risk Badge
```markdown
[![EVM Risk Status](https://venture-engine-gateway.leonid-ai-global.workers.dev/v1/badge?address=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&chain=base)](https://venture-engine-gateway.leonid-ai-global.workers.dev/)
```

# `venture-engine-sdk` (Python 3.12 Stdlib)

Zero-dependency Python client SDK for the **Venture Engine Unified Edge Gateway** (`https://venture-engine-gateway.leonid-ai-global.workers.dev`).

## Requirements
- Python >= 3.11 (tested on Python 3.12; uses only `urllib.request`, `urllib.parse`, `urllib.error`, `json`).

## Quick Start

```python
import os
from venture_engine_sdk import VentureEngineClient, VentureEngineError

client = VentureEngineClient(api_key=os.environ.get("VE_API_KEY"))

# 1. Screen an EVM address (AegisGate)
screen = client.screen_address("0x2222222222222222222222222222222222222222", chain="base")
print(screen["report"]["verdict"])

# 2. Estimate EIP-1559 gas & simulate transaction (GasPulse)
gas = client.estimate_gas("base")
sim = client.simulate_transaction({
    "chain": "base",
    "from": "0x1111111111111111111111111111111111111111",
    "to": "0x2222222222222222222222222222222222222222",
    "data": "0x",
})

# 3. Inspect smart-contract invariants (AuditPulse)
report = client.inspect_contract("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", chain="base")

# 4. Remote HTTP MCP tool call (POST /mcp)
mcp_res = client.call_mcp_tool("estimate_gas", {"chain": "arbitrum"})
```

## Self-Serve x402 & KYB Onboarding
- Receive-only Base Mainnet USDC treasury: `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`
- Base Mainnet USDC asset: `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
- Unauthenticated paid calls raise `VentureEngineError` with `err.status == 402` and `err.body["accepts"]`.

## Test
```bash
python -m unittest discover -s tests
```

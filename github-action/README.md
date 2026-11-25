# Venture Engine EVM Guard GitHub Action

Zero-dependency CI/CD GitHub Action (`uses: nuvoraxis/venture-engine/github-action@main`) that screens smart contract, deployer, and treasury EVM addresses against **AegisGate** via the Venture Engine Gateway before deployment or merge.

## Quickstart (`.github/workflows/evm-guard.yml`)

```yaml
name: EVM Security & Sanctions Guard
on:
  pull_request:
  push:
    branches: [main]

jobs:
  evm-guard:
    runs-on: ubuntu-latest
    steps:
      - name: Screen Target Contracts & Treasury Addresses
        uses: nuvoraxis/venture-engine/github-action@main
        with:
          addresses: |
            0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
            0x4200000000000000000000000000000000000006
          chain: base
          api-key: ${{ secrets.VE_API_KEY }}
          fail-on-verdict: BLOCK
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `addresses` | Yes | — | Comma- or newline-separated `0x` EVM addresses (max 50) |
| `chain` | No | `base` | Target chain: `base`, `ethereum`, or `arbitrum` |
| `gateway-url` | No | `https://venture-engine-gateway.leonid-ai-global.workers.dev` | Venture Engine Gateway URL |
| `api-key` | No | `""` | B2B `X-Api-Key` (`ve_live_...`) from GitHub Secrets |
| `payment-tx` | No | `""` | Base Mainnet USDC x402 `txHash` (`0x703d3948cc102bf4bc0ef93ef330f56be2afd69c`) |
| `fail-on-verdict` | No | `BLOCK` | Fail CI when verdict reaches `BLOCK` or `REVIEW` |

> **Dry-Demo Mode:** When neither `api-key` nor `payment-tx` is configured, the action validates all address formats locally and runs `GET /v1/demo?check=aegis` to verify live Gateway connectivity without failing CI on your repository addresses.

## Outputs

- `results-json`: JSON array of screening reports.
- `highest-verdict`: Highest verdict observed (`ALLOW`, `REVIEW`, or `BLOCK`).

## Local Test

```bash
npm test
```

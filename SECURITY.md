# Security & Confidentiality Policy (Local Laptop Isolation)

## 1. Zero-Exposure Laptop Rule
- **Never expose localhost to the internet** (no port forwarding, no `ngrok`/`cloudflared` tunnels serving public APIs from this machine).
- All public production endpoints (`AegisGate`, etc.) must run strictly on **external isolated serverless/cloud** (Cloudflare Workers / Vercel / Render), never from the user's home IP.

## 2. PII & Metadata Hygiene
- Public repositories, `package.json`, HTTP headers, and git commits must **never** contain the local Windows username, `C:\Users\...` paths, local hostnames, or personal emails.
- Local git identity inside `venture-engine` is pinned to the pseudonymous project handle (`nuvoraxis` / `users.noreply.github.com`).

## 3. Secret & Key Hygiene (Fail-Closed)
- Zero private keys, mnemonics, or signing capabilities anywhere on disk. Treasury `0x703d3948cc102bf4bc0ef93ef330f56be2afd69c` is strictly **receive-only**.
- No `.env` files, API tokens (`ghp_`, `github_pat_`, `sk-`, `Bearer`), or credentials may be committed or logged.

## 4. Untrusted Input & Memory Safety (~4 GB RAM)
- All external RPC responses, contract metadata, and HTTP inputs are strictly schema-validated; never `eval`/`Function`/`exec` untrusted strings.
- Background processes must be bounded and terminated cleanly after task completion.

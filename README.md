# Optle — onchain gas optimization for Solidity

Optle takes a Solidity (Foundry) project, optimizes its gas usage with an AI
agent, **verifies the savings with the project's own tests**, and hands back a
deployable build — and you pay per run in **USDC over [x402](https://x402.org)**,
settled on **Mantle Sepolia**.

- **Landing:** https://optle.hanjun.kim
- **App:** https://optle.hanjun.kim/app
- Testnet only. Mantle Sepolia (chainId `5003`), test USDC, no real funds.

---

## Why

Gas optimization is real work that's easy to get wrong (a faster contract that
breaks a test is worthless). Optle makes it a one-shot service:

1. **Upload** a Foundry project `.zip`.
2. **Pay** a size-based price in USDC — no account, no subscription, just an
   x402 micropayment your wallet signs (gasless EIP-3009 authorization).
3. The server runs an **isolated container** that snapshots gas, applies
   behaviour-preserving optimizations, and re-runs `forge test` to **prove** the
   gas went down and nothing broke.
4. **Download** an optimized build with a per-file diff. Your original `src/` is
   never modified — optimized code lands in a separate `optimized/` directory.

The same x402-gated endpoint a human pays through can be called by an agent or CI
— the human UI is just the visible version of an agent-native payment flow.

## How it works

```
 Browser ──┐                         Netlify (optle.hanjun.kim)
           │  /api, /health  (same-origin proxy)         static SPA
           ▼
   Caddy (api.optle.hanjun.kim, auto-HTTPS)  ── Tencent Cloud CVM ──────────────┐
     └─ server :8080 (x402 gate, jobs)                                          │
          ├─ Tencent COS  ── input.zip / output.zip                            │
          ├─ facilitator :8090  (internal) ── verify + settle on Mantle Sepolia │
          └─ docker run  ── optle-runner (isolated per job) ────────────────────┘
                              snapshot → optimize → forge verify → re-measure
```

- **Payment (x402 `exact`).** No third-party facilitator: a self-hosted
  facilitator (`apps/facilitator`) verifies the client's signed EIP-3009
  `transferWithAuthorization` and submits it on-chain, paying gas from a relayer
  wallet. Settles are serialized to avoid relayer nonce races.
- **Isolation.** Each job runs in a throwaway `docker run` container with CPU /
  memory / pid limits. The mock engine runs with `--network none`; the AI engine
  gets network to reach the Anthropic API.
- **Verification.** A Foundry project is built and tested before and after; the
  optimized variant is measured against the same suite. Savings shown are real,
  not estimated (when the project builds).

## The optimizer

The agent loads the [`solidity-gas-optimizer`](skills/gas-optimizer/SKILL.md)
skill (with a condensed [pattern corpus](skills/gas-optimizer/references/pattern-corpus.md)
distilled from Solady, Uniswap v3/v4, and Cyfrin Solodit findings). Two depths,
selectable in the UI:

| Level | Scope | Speed |
|---|---|---|
| **1** | Function-body only (cache SLOADs, custom errors, `unchecked`, `++i`, `constant`/`immutable`, `public`→`external`, `calldata`) — storage layout unchanged | fast |
| **2** | Everything in L1 **plus** storage redesign (struct/slot packing, bitmaps, smaller types) — new-deployment only | deeper, slower |

**Engine selection (`OPTLE_ENGINE`):** `auto` uses the real Claude agent when an
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is configured, else an offline
**mock** pass. Set `OPTLE_ENGINE=mock` on a public site to keep it free and fast;
use `auto` for the real run.

## Pricing

Computed from the uploaded `.zip` (counts source `.sol` files + bytes, excluding
tests/scripts/libs) and injected into the x402 challenge per job:

| Tier | Condition | Price |
|---|---|---|
| Small | ≤ 3 files **and** ≤ 30 KB | $0.50 |
| Medium | ≤ 20 files **and** ≤ 200 KB | $3.00 |
| Large | larger | $10.00 |

## Repository

```
apps/
  web/          Vite + React + wagmi/viem/RainbowKit frontend (landing + step-based app)
  server/       Express x402 gate: /upload, /optimize/:jobId, /status, /download
  facilitator/  Self-hosted x402 facilitator (verify + on-chain settle)
  runner/       Isolated optimizer image (Foundry + Node + Claude Agent SDK)
contracts/      Foundry: TestUSDC (EIP-3009) + Mantle Sepolia deploy script
skills/         gas-optimizer skill (SKILL.md + pattern corpus)
examples/       staking-demo — an intentionally inefficient project for demos
poc/            Agent-SDK proof of concept
DEPLOY.md       Full deployment guide (CVM + Caddy + Netlify + COS)
```

## Local development

The frontend dev server proxies the API to the **deployed backend** by default,
so you can work on the UI without running anything else:

```bash
cd apps/web
npm install
npm run dev            # http://localhost:5173  (proxies /api → https://api.optle.hanjun.kim)
```

To develop against a local backend instead, set `DEV_API_TARGET=http://localhost:8080`.
Each app has a `.env.example`; copy it to `.env` and fill in as needed.

Backend CORS is permissive (`Access-Control-Allow-Origin: *`, the `X-PAYMENT`
request header is allowed and `X-PAYMENT-RESPONSE` is exposed), so direct
cross-origin calls work too; the dev proxy just keeps things same-origin.

## Deploying

See **[DEPLOY.md](DEPLOY.md)** — frontend on Netlify, backend on a Tencent Cloud
CVM via `docker compose` behind Caddy (auto-HTTPS), Tencent COS for object
storage. Build the runner image with `docker compose --profile build build runner`.

## Tech

Solidity / Foundry · x402 + EIP-3009 USDC · Mantle Sepolia · Tencent Cloud (CVM
+ COS) · Caddy · Docker · Node/TypeScript/Express · viem · React/Vite · wagmi +
RainbowKit · Claude Agent SDK · Netlify.

## Security notes

Everything here targets **testnet** and is built for a hackathon demo: keys are
testnet-only, secrets live in gitignored `.env` files (never committed), job
state is in-memory, and there's no auth/rate-limiting. Do not point it at mainnet
or real funds as-is.

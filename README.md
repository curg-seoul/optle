# Optle — onchain gas optimization for Solidity

Optle takes a Solidity (Foundry) project, optimizes its gas usage with an AI
agent, **verifies the savings with the project's own tests**, and returns a
deployable build — and you pay per run in **USDC over [x402](https://x402.org)**,
settled on **Mantle Sepolia** (testnet).

## Flow

1. **Upload** a Foundry project `.zip`.
2. **Pay** a size-based price in USDC — no account or subscription, just an x402
   micropayment your wallet signs (gasless EIP-3009 authorization).
3. An **isolated container** snapshots gas, applies behaviour-preserving
   optimizations, and re-runs `forge test` to prove gas dropped and nothing broke.
4. **Download** an optimized build with a per-file diff. The original `src/` is
   never touched — optimized code goes to a separate `optimized/` directory.

The same x402-gated endpoint a human pays through can be driven by an agent or CI.

## Architecture

```
 Browser ──┐                         Netlify (static SPA)
           │  /api, /health  (same-origin proxy)
           ▼
   Caddy (auto-HTTPS)  ── CVM ─────────────────────────────────────────┐
     └─ server :8080 (x402 gate, jobs)                                  │
          ├─ object storage (COS)  ── input.zip / output.zip            │
          ├─ facilitator :8090 (internal) ── verify + settle on-chain   │
          └─ docker run optle-runner (isolated per job) ────────────────┘
                snapshot → optimize → forge verify → re-measure
```

- **Payment (x402 `exact`).** A self-hosted facilitator (`apps/facilitator`)
  verifies the client's signed EIP-3009 `transferWithAuthorization` and submits
  it on-chain, paying gas from a relayer wallet — no third-party facilitator.
- **Isolation.** Each job runs in a throwaway container with CPU/memory/pid
  limits (mock engine runs with `--network none`).
- **Verification.** The project is built and tested before and after; reported
  savings are measured, not estimated (when the project builds).

## The optimizer

The agent loads the [`solidity-gas-optimizer`](skills/gas-optimizer/SKILL.md)
skill (a condensed pattern corpus from Solady, Uniswap v3/v4, and Cyfrin Solodit).
Two depths, selectable in the UI:

| Level | Scope |
|---|---|
| **1** | Function-body only (cache SLOADs, custom errors, `unchecked`, `constant`/`immutable`, `public`→`external`, `calldata`); storage layout unchanged. |
| **2** | L1 + storage redesign (struct/slot packing, bitmaps, smaller types); new-deployment only. |

`OPTLE_ENGINE=auto` uses the real Claude agent when a key/token is configured,
else an offline **mock** pass; set `OPTLE_ENGINE=mock` to keep a public site free.

## Pricing

From the uploaded `.zip` (source `.sol` files + bytes, excluding tests/scripts/libs):

| Tier | Condition | Price |
|---|---|---|
| Small | ≤ 3 files and ≤ 30 KB | $0.50 |
| Medium | ≤ 20 files and ≤ 200 KB | $3.00 |
| Large | larger | $10.00 |

## Repository

```
apps/web/          React + wagmi/viem/RainbowKit frontend (landing + step-based app)
apps/server/       Express x402 gate: /upload, /optimize/:jobId, /status, /download
apps/facilitator/  Self-hosted x402 facilitator (verify + on-chain settle)
apps/runner/       Isolated optimizer image (Foundry + Node + Claude Agent SDK)
contracts/         Foundry: TestUSDC (EIP-3009) + Mantle Sepolia deploy script
skills/            gas-optimizer skill (SKILL.md + pattern corpus)
examples/          staking-demo — an intentionally inefficient project for demos
```

## Local development

The frontend dev server proxies the API to the deployed backend by default, so
the UI runs without anything else:

```bash
cd apps/web && npm install && npm run dev   # http://localhost:5173
```

Set `DEV_API_TARGET=http://localhost:8080` to develop against a local backend.
Each app has a `.env.example` — copy to `.env` and fill in. Deployment is in
[DEPLOY.md](DEPLOY.md).

## Tech

Solidity / Foundry · x402 + EIP-3009 USDC · Mantle Sepolia · Caddy · Docker ·
Node/TypeScript/Express · viem · React/Vite · wagmi + RainbowKit · Claude Agent SDK.

## Notes

Targets **testnet** only and is built for a hackathon demo: keys are testnet-only,
secrets live in gitignored `.env` files, job state is in-memory, and there is no
auth or rate-limiting. Don't point it at mainnet or real funds as-is.

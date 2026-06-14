# Deployment

Frontend → **Netlify** (`optle.hanjun.kim`). Backend → **Tencent Cloud CVM**
running Docker Compose behind **Caddy** (`api.optle.hanjun.kim`, auto-HTTPS).

```
Browser ──https──▶ Netlify (optle.hanjun.kim, static SPA)
                     │  /api/*, /health  (server-side proxy rewrite, see netlify.toml)
                     ▼
                   Caddy (api.optle.hanjun.kim, auto Let's Encrypt) ── CVM
                     └─ reverse_proxy → server:8080
                                          └─ facilitator:8090 (internal only)
                                                └─ → rpc.sepolia.mantle.xyz
```

The browser only ever talks to the Netlify origin, so the custom `X-PAYMENT`
header stays same-origin (no CORS preflight). USDC balance reads go straight from
the browser to the Mantle RPC.

---

## 1. DNS (do this first — Caddy needs it to issue a cert)

| Record | Host | Value |
|---|---|---|
| A | `api.optle.hanjun.kim` | CVM public IP |
| CNAME / Netlify DNS | `optle.hanjun.kim` | (set by Netlify when you add the custom domain) |

## 2. Backend — Tencent Cloud CVM

1. Create a CVM (Ubuntu 22.04, 2 vCPU / 2–4 GB). **Hong Kong / Singapore region**
   to avoid mainland ICP filing.
2. Security group inbound: `22` (your IP only), `80`, `443`. Nothing else —
   8080/8090 stay internal to the compose network.
3. Install Docker + compose plugin:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
4. Get the code and create the two env files (they are gitignored, so copy or
   recreate them on the box):
   ```bash
   git clone <repo> && cd mantle-hackathon
   # apps/server/.env       — PAY_TO_ADDRESS, PAYMENT_ASSET_*, ANTHROPIC_API_KEY (real key)
   #                          FACILITATOR_URL/PAYMENT_MODE are overridden by compose.
   # apps/facilitator/.env  — RELAYER_PRIVATE_KEY (funded with MNT), RPC_URL, CHAIN_ID
   ```
   Use each app's `.env.example` as the template.
5. Launch:
   ```bash
   docker compose up -d --build
   docker compose logs -f          # watch logs over SSH
   ```
6. Verify: `curl https://api.optle.hanjun.kim/health` → JSON. (First request may
   take a few seconds while Caddy provisions the TLS cert.)

## 3. Frontend — Netlify

1. New site from the git repo. `netlify.toml` already sets base `apps/web`, build
   `npm run build`, publish `dist`, and the `/api` + `/health` proxy rewrites.
2. Add custom domain `optle.hanjun.kim` (Netlify will give you the DNS target).
3. (Optional) Site settings → Environment variables → `VITE_WALLETCONNECT_PROJECT_ID`
   for mobile-wallet QR in the connect modal.
4. Deploy. Open `https://optle.hanjun.kim`, connect a wallet on Mantle Sepolia
   that holds the test USDC, and run Optimize → confirm → pay.

## Operations

- Update backend: `git pull && docker compose up -d --build`
- Logs: `docker compose logs -f server` (or `facilitator` / `caddy`)
- Restart: `docker compose restart`
- The relayer wallet needs MNT for gas — top it up from a faucet if settles fail.

## Notes / caveats

- All keys here are **testnet-only**. Don't reuse them anywhere with real value.
- If you change `PAYMENT_PRICE` in `apps/server/.env`, the frontend shows the new
  amount automatically (it reads the live 402 challenge).
- `docker compose` reads the `.env` files at `up` time from the host — they are
  not baked into the images (`.dockerignore` excludes them).

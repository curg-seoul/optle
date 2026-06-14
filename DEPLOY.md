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
   # apps/server/.env       — PAY_TO_ADDRESS, PAYMENT_ASSET_*, and COS_* (bucket + keys).
   #                          FACILITATOR_URL/PAYMENT_MODE/JOBS_DIR/HOST_JOBS_DIR are set by compose.
   # apps/facilitator/.env  — RELAYER_PRIVATE_KEY (funded with MNT), RPC_URL, CHAIN_ID
   ```
   Use each app's `.env.example` as the template. **COS is required** for the
   upload/optimize/download pipeline (see §4 for the bucket + keys).
5. Prepare the host job dir and build the isolated runner image:
   ```bash
   sudo mkdir -p /srv/optle-jobs            # bind-mounted into server + runner containers
   sudo chmod 777 /srv/optle-jobs
   docker compose --profile build build runner   # builds the `optle-runner` image
   ```
6. Launch:
   ```bash
   docker compose up -d --build
   docker compose logs -f          # watch logs over SSH
   ```
7. Verify: `curl https://api.optle.hanjun.kim/health` → `{"ok":true,...,"cos":true}`.
   (First request may take a few seconds while Caddy provisions the TLS cert.
   `"cos":false` means COS_* env is missing — uploads will 503.)

## 3. Frontend — Netlify

1. New site from the git repo. `netlify.toml` already sets base `apps/web`, build
   `npm run build`, publish `dist`, and the `/api` + `/health` proxy rewrites.
2. Add custom domain `optle.hanjun.kim` (Netlify will give you the DNS target).
3. (Optional) Site settings → Environment variables → `VITE_WALLETCONNECT_PROJECT_ID`
   for mobile-wallet QR in the connect modal.
4. Deploy. Open `https://optle.hanjun.kim`, connect a wallet on Mantle Sepolia
   that holds the test USDC, and run Optimize → confirm → pay.

## 4. Tencent COS (object storage) — required for uploads/downloads

Do this in the Tencent Cloud console (same Singapore region as the CVM):

1. **COS → Create bucket**, region `ap-singapore` (Singapore), private. Note the
   full bucket name (it includes your APPID), e.g. `optle-jobs-1250000000`.
2. **CAM → API keys** → create a key. Note `SecretId` / `SecretKey`
   (a demo/main key is fine — testnet only).
3. Put them in `apps/server/.env` on the CVM:
   ```
   COS_BUCKET=optle-jobs-1250000000
   COS_REGION=ap-singapore
   COS_SECRET_ID=...
   COS_SECRET_KEY=...
   ```
   No bucket CORS needed: uploads go through the server (same-origin via Netlify),
   downloads use a presigned GET opened as a normal link.

## How the optimize pipeline works (v2)

`/api/upload` (zip → COS + price) → `/api/optimize/:jobId` (x402-gated at the tier
price) → server downloads the zip, runs `optle-runner` in an isolated container
(`--network none`, mem/cpu/pids limits) that does snapshot → optimize → `forge`
verify → re-measure, packages the result to `output.zip` in COS →
`/api/status/:jobId` polling → `/api/download/:jobId` (presigned URL).

## Operations

- Update backend code: `git pull && docker compose up -d --build`
- **Rebuild the runner** after changing `apps/runner/`: `docker compose --profile build build runner`
- Logs: `docker compose logs -f server` (or `facilitator` / `caddy`); job runs log as `[runner <id>]`
- Restart: `docker compose restart`
- The relayer wallet needs MNT for gas — top it up from a faucet if settles fail.

## Notes / caveats

- All keys here are **testnet-only**. Don't reuse them anywhere with real value.
- Pricing is by project-size tier ($0.50 / $3 / $10 — `apps/server/src/pricing.ts`),
  computed from the uploaded zip and injected into the x402 challenge per job.
- The optimizer engine is currently a **mock** pass that real `forge` tests verify;
  swap `optimizeSource()` in `apps/runner/run.mjs` for the Claude Agent SDK to go live.
- `docker compose` reads the `.env` files at `up` time from the host — they are
  not baked into the images (`.dockerignore` excludes them).
- Job state is in-memory (volatile across restarts); the files persist in COS.

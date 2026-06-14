# Deployment

Frontend on **Netlify** (static); backend on a Linux VM running **Docker Compose**
behind **Caddy** (auto-HTTPS), with **object storage** (Tencent COS or any
S3-compatible store) for job files.

> The committed `Caddyfile`, `netlify.toml`, and `vite.config.ts` use the
> maintainer's domains — replace `api.example.com` / `app.example.com` below (and
> in those files) with your own.

```
Browser ─https─▶ Netlify (static SPA)
                  │  /api/*, /health  → proxied to the backend (netlify.toml)
                  ▼
                Caddy (auto-HTTPS) ── VM
                  └─ server:8080 ── facilitator:8090 (internal) ── runner (per-job container)
```

## 1. Object storage (required)

Create a private COS bucket and an API key (`SecretId` / `SecretKey`). No bucket
CORS needed — uploads go through the server, downloads use a presigned GET.

## 2. Backend (VM)

1. VM: Ubuntu 22.04, 2 vCPU / 2–4 GB. Open inbound `22` (your IP), `80`, `443`
   only — `8080`/`8090` stay internal to the compose network.
2. Install Docker: `curl -fsSL https://get.docker.com | sh`
3. Point an A record `api.example.com` → VM public IP (Caddy needs it for a cert).
4. Clone the repo and create the env files from the templates (gitignored):
   - `apps/server/.env` — `PAY_TO_ADDRESS`, `PAYMENT_ASSET_*`, `COS_*`, and
     `OPTLE_ENGINE` (`mock` for a public site, `auto` + a Claude key for real runs).
   - `apps/facilitator/.env` — `RELAYER_PRIVATE_KEY` (funded with testnet gas),
     `RPC_URL`, `CHAIN_ID`.
5. Prepare the job dir, build the runner image, and launch:
   ```bash
   sudo mkdir -p /srv/optle-jobs && sudo chmod 777 /srv/optle-jobs
   docker compose --profile build build runner   # builds the optle-runner image
   docker compose up -d --build
   ```
6. Verify: `curl https://api.example.com/health` → `{"ok":true,...,"cos":true}`
   (`"cos":false` means `COS_*` is missing).

## 3. Frontend (Netlify)

New site from the repo — `apps/web/netlify.toml` sets the base, build, publish dir,
and proxies `/api` + `/health` to the backend (edit the target to your API
domain). Add your custom domain; optionally set `VITE_WALLETCONNECT_PROJECT_ID`.

## Operations

- Update: `git pull && docker compose up -d --build`
- Rebuild the runner after changing `apps/runner/` or the skill:
  `docker compose --profile build build runner`
- Logs: `docker compose logs -f server` (job runs appear as `[runner <id>]`)
- The relayer wallet needs gas; top it up if settles fail. For real-AI runs bump
  `RUNNER_TIMEOUT_MS`.

## Notes

- Testnet only; keys are testnet-only and live in gitignored `.env` files (read at
  `up` time, not baked into images).
- Job state is in-memory (volatile across restarts); files persist in storage.
- Engine: `OPTLE_ENGINE=mock` forces the offline mock; `auto` uses the Claude
  agent when `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set (runner gets
  network in AI mode). Pricing tiers live in `apps/server/src/pricing.ts`.

# Free-tier deployment runbook

Updated: 2026-10-31 (Asia/Kolkata)

Target: Oracle Cloud Always Free Ampere A1 serving **both** the React SPA (via
Caddy) and the existing FastAPI backend, plus existing Supabase Free for
PostgreSQL and private Storage. No paid resource, API, or plan is required.

Cloudflare Pages is **not used**: the production build contains a 25.61 MiB
ONNX Runtime WASM file, above the Pages 25 MiB per-file limit. Self-hosting the
SPA on the same Caddy origin removes that limit and avoids cross-origin CORS.
See `CLOUDFLARE_DEPLOYMENT_COMPATIBILITY.md`.

**Deployment status: not executed.** There is no Cloudflare API token, Oracle
tenancy, SSH key, or Supabase production credential in this environment. This
runbook and the artifacts in `deploy/` are prepared and locally validated where
possible; the external provisioning steps remain blocked.

## 1. Component map

```text
Browser
  └─ https://<app-domain>/            → Caddy static SPA (/srv/app)
  └─ https://<app-domain>/api/*       → Caddy → FastAPI (single worker) on Oracle A1
                                            ├─ psycopg → Supabase session pooler (TLS)
                                            └─ HTTPS → Supabase Storage (private buckets)

One origin, one TLS certificate, no CORS. VITE_API_BASE_URL is the relative
path `/api`. The voice assistant is disabled in the production build
(VITE_VOICE_ENABLED=false); the lazy voice/WASM assets stay on disk but are
never fetched while the panel is hidden.
```

## 2. Oracle Cloud Always Free — verified limits and risks

As of October 2026, the official Always Free allowances that matter here are:

| Resource | Free allowance | Notes |
| --- | --- | --- |
| Ampere A1 (`VM.Standard.A1.Flex`) | 1,500 OCPU-hours and 9,000 GB-hours per month, i.e. **2 OCPU / 12 GB** total across A1 instances for Always Free tenancies | Some Oracle pages have shown 4 OCPU / 24 GB; the conservative documented figure is 2 / 12. Check the **Always Free-eligible** label in the console. |
| AMD micro (`VM.Standard.E2.1.Micro`) | 2 instances | Fallback if A1 capacity is unavailable; much weaker CPU. |
| Block volume | 200 GB total | Default boot volume is usually smaller. |
| Outbound data transfer | 10 TB/month | The shop workload is far below this. |
| Public IPv4 | Reserved/public IP included on free compute | Do not create extra paid networking resources. |

Risks that must be accepted:

- **Capacity shortages.** A1 launches often fail with "out of host capacity" in
  popular regions. Retrying many times can look abusive; do not script a
  hammering loop. Try another availability domain or region, or use the AMD
  micro fallback temporarily.
- **Idle reclamation.** Oracle may reclaim an Always Free instance it considers
  idle over 7 days: 95th-percentile CPU below 20%, network below 20%, and for A1
  memory below 20%. The backend is a low-traffic shop app and may look idle.
  Oracle emails before reclaiming. Back up Supabase regularly and keep the
  deployment reproducible. Do not create fake load to evade the policy.
- **Rule changes.** Free-tier shapes and limits have changed before (including
  the 2026 reduction to 2 OCPU/12 GB). Re-check the console and billing page.
- **No SLA / no support.** Free tier has no production SLA. Supabase Free also
  pauses projects after about **7 days of inactivity**. A shop that is inactive
  for a week can lose API availability until the project is resumed. This is a
  real production limitation of the ₹0 path, not a temporary bug.

## 3. Linux ARM64 compatibility — verified

The repository's runtime dependencies are pure Python except for `psycopg[binary]`
and Pillow. Both publish `manylinux aarch64` wheels. A dry-run download for
CPython 3.12 / aarch64 resolved:

```text
psycopg_binary 3.3.6   cp312 manylinux_2_28_aarch64
Pillow 11.3.0          cp312 manylinux2014_aarch64
SQLAlchemy 2.0.35      cp312 manylinux2014_aarch64
fastapi / uvicorn / reportlab / pydantic-core: aarch64 or pure-Python wheels
```

So the existing backend does **not** need a source build on ARM64 when the
Docker image uses CPython 3.12. `reportlab` is pure Python and works with the
ARM64 Pillow wheel. `faster-whisper` is deliberately excluded from the
production image (see `deploy/Dockerfile`); it is optional and only used by the
API transcription endpoint, not by the browser assistant.

Not verified: an actual ARM64 boot, Docker build, or Oracle run. This machine is
macOS **arm64** and the Docker daemon is not running, so only wheel availability
and the PostgreSQL migration were tested locally. See
`ARM64_COMPATIBILITY_REPORT.md` for the current wheel-resolution evidence.

## 4. Server provisioning (manual, requires an Oracle account)

1. Create an Always Free tenancy in a region close to Madurai/India if possible.
2. Create `VM.Standard.A1.Flex` with **2 OCPU / 12 GB**, Ubuntu 24.04 ARM64
   (or Oracle Linux 9 ARM64), 50–100 GB boot volume within the 200 GB free pool.
   Confirm the instance shows **Always Free-eligible**.
3. Add your SSH public key at creation. Never enable a password-only SSH login.
4. In the subnet security list / NSG, allow ingress only:
   - TCP 22 from your admin IP (not `0.0.0.0/0` if avoidable)
   - TCP 80 and 443 from anywhere (Caddy needs 80 for ACME and 443 for the API)
   Do not open 8000, 5432, or 6379.
5. SSH in and install Docker Engine + Compose plugin from Docker's official
   Ubuntu repository for arm64. Enable it at boot:
   ```bash
   sudo systemctl enable --now docker
   sudo usermod -aG docker "$USER"   # log out/in
   ```
6. Add a small swap file only if the host has 12 GB RAM and no other services:
   ```bash
   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
   sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```
   Swap is not a substitute for RAM; it prevents surprise OOM kills during PDF
   generation.
7. Enable automatic security updates and a host firewall:
   ```bash
   sudo apt install -y unattended-upgrades ufw
   sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
   sudo ufw enable
   ```
   Oracle's cloud firewall and `ufw` must both allow 80/443.

## 5. DNS and TLS without a paid domain

Caddy can obtain a free Let's Encrypt certificate for any DNS name you control.
Two zero-cost options:

- Use an existing client domain if one exists (best for production).
- Use a free dynamic-DNS subdomain such as DuckDNS and point it at the Oracle
  public IP. This is free but depends on that provider's availability and terms.

A bare IP address cannot get a normal Let's Encrypt certificate. Do not run the
SPA or API over plain HTTP: both share one HTTPS origin, and browsers block
mixed content. Cloudflare Tunnel is another free TLS option, but a stable named
tunnel needs a domain; the quick `trycloudflare.com` tunnels are not suitable
for production.

## 6. Deploy the backend on the server

```bash
sudo mkdir -p /opt/embroidery && cd /opt/embroidery
# copy this repository here (git clone or rsync over SSH)
cp deploy/backend.env.example deploy/backend.env
chmod 600 deploy/backend.env
# edit deploy/backend.env with the real Supabase and admin values

# Caddy needs the DNS name (it is also the app origin):
printf 'BACKEND_DOMAIN=%s\n' 'your-name.duckdns.org' > deploy/systemd.env
chmod 600 deploy/systemd.env

# Build the SPA first. Caddy mounts ../frontend/dist read-only at /srv/app.
# Voice is disabled for this deployment (see the go-live decision).
cd frontend
npm ci
VITE_API_BASE_URL=/api VITE_VOICE_ENABLED=false npm run build
cd ..

# Build and start. The first build compiles nothing native on ARM64.
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps
curl -fsS https://your-name.duckdns.org/api/health && echo ' API OK'
```

The backend container binds only to `127.0.0.1:8000`; Caddy exposes 80/443,
terminates TLS, serves the SPA from `/srv/app`, and proxies `/api/*` to the
backend. Because the SPA and API share one origin, no CORS is involved. The app
runs one uvicorn worker on purpose: conversation state, login throttling, and
rate limits are process-local. Do not add workers without moving that state to
a shared store.

Process management: install `deploy/embroidery-backend.service` as
`/etc/systemd/system/embroidery-backend.service`, adjust `WorkingDirectory`,
then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now embroidery-backend
sudo systemctl status embroidery-backend
```
Docker's `restart: unless-stopped` also restarts containers after daemon or VM
reboot. Logs: `docker compose logs -f backend`; use Docker's default rotation or
configure `logging.options.max-size`/`max-file`.

Secrets:

- `deploy/backend.env` and `deploy/systemd.env` must be `chmod 600`, owned by the
  deploy user, and never committed.
- `APP_SECRET_KEY` must be random, e.g. `openssl rand -hex 32`.
- The Supabase **service-role** key stays server-side. It must never be a
  `VITE_` variable, React source, static asset, or browser storage value.
- Remove `ADMIN_INITIAL_PASSWORD` after the first successful initialization.
- Rotate the service-role key and admin password if a server image or env file
  is ever exposed.

## 7. Supabase PostgreSQL pooling

Use the **session pooler** connection string (usually port `5432`) with
`?sslmode=require` for the current synchronous SQLAlchemy + psycopg stack:

```text
postgresql+psycopg://postgres.<ref>:<password>@<pooler-host>:5432/postgres?sslmode=require
```

Reasons:

- The app uses synchronous SQLAlchemy with process-local transactions and
  `SELECT ... FOR UPDATE`; session mode preserves that behavior.
- Supavisor's **transaction** mode (port `6543`) does not support prepared
  statements. psycopg 3 does not use server-side prepared statements by default,
  but it can prepare after repeated executions; transaction mode may require
  `prepare_threshold=None`. That setting is **not** currently wired into this
  repository. Use session mode unless you add and test that setting.
- A single backend worker with SQLAlchemy's default pool (5 connections + 10
  overflow) is far below the Nano free pooler allowance (reported as 60 direct /
  200 pooler connections). Do not raise the pool without measuring.
- Supabase Free may pause a project after about 7 days of inactivity. The API
  will fail while paused; this is not handled by automatic retry. Monitor it and
  resume from the Supabase dashboard. Do not build a paid auto-resume workaround.

Not verified: connecting to the actual client Supabase project. Production
credentials were intentionally not used and the client database was not touched.

## 8. Database migration before first start

The backend fails closed in `APP_ENV=production` unless migration `0003` is
applied. Apply it to a **development/Preview** database first, then to production
only after a verified backup and explicit owner approval:

```bash
psql "$DEV_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f backend/migrations/0003_session_invoice_snapshots_and_idempotency.sql
```

Local validation in this task used PostgreSQL 17.10, a pre-migration schema, an
existing `INV-2026-005` row, then the real migration file:

- `invoice_sequences` seeded to `2026 → 6` (max existing invoice + 1).
- `admin_sessions`, `invoice_sequences`, the two new `orders` columns, the
  `transactions.idempotency_key` column, and all three indexes were created.
- The app then created `INV-2026-007`, replayed a duplicate order without a new
  row, recorded a payment once, replayed the duplicate payment, and generated a
  valid PDF.
- Production Supabase was not modified; migration `0003` is still unapplied
  there.

## 9. Deploy the frontend on the same host (Caddy)

Owner decision: the SPA is served by the same Caddy instance as the API, not by
Cloudflare Pages. This is what removes the 25 MiB Pages per-file failure.

```bash
cd /opt/embroidery/frontend
npm ci
VITE_API_BASE_URL=/api VITE_VOICE_ENABLED=false npm run build
cd ..
# dist is now at /opt/embroidery/frontend/dist and is bind-mounted read-only
# into Caddy at /srv/app by deploy/docker-compose.yml.
docker compose -f deploy/docker-compose.yml up -d
curl -fsS https://your-name.duckdns.org/ | head -c 200
```

Notes:

- `VITE_API_BASE_URL=/api` is a **relative** path because the SPA and API share
  one origin. Do not use an absolute URL unless you intentionally split origins.
- `VITE_VOICE_ENABLED=false` hides the voice assistant in production. The build
  still emits lazy voice/WASM chunks, but they are never fetched while the panel
  is hidden. Re-enable only after physical microphone acceptance passes.
- `FRONTEND_ORIGIN` should be `https://your-name.duckdns.org` (the same origin).
  CORS is not exercised for same-origin requests, but keep the allow-list exact.
- `VITE_` values are public build inputs; never put secrets there.
- The SPA uses `try_files {path} /index.html`, so client-side routes work.
- Rebuilds replace `frontend/dist`; keep the previous `dist` archived for rollback
  (see `ROLLBACK_PLAN.md`). Caddy serves files directly, so no cache purge is
  needed, but browsers may cache a hashed bundle; hashed filenames handle this.
- Caddy's `handle /api/*` rule proxies only the API path. `/docs` and
  `/openapi.json` are intentionally not exposed through the SPA origin.
- **Cloudflare Pages is not used.** Its 25 MiB per-file limit rejects the
  26,861,777-byte (25.61 MiB) ONNX Runtime WASM asset. The evidence and the
  rejected alternatives are in `CLOUDFLARE_DEPLOYMENT_COMPATIBILITY.md`.
- Deployment was **not performed here**; no Oracle host or DNS name exists yet.

## 10. Cost and free-tier limits

| Item | Expected cost | Limit / risk |
| --- | --- | --- |
| Oracle A1 Always Free (SPA + API) | ₹0 | 2 OCPU/12 GB total, capacity shortages, idle reclamation, no SLA |
| Supabase Free | ₹0 | 500 MB DB, 1 GB Storage, 5 GB egress, pause after ~7 days idle, 2 projects |
| Let's Encrypt via Caddy | ₹0 | Rate limits; needs a DNS name you control |
| Cloudflare Pages | **not used** | 25 MiB per-file limit rejects the WASM asset |
| Hugging Face model downloads | **not used in production** | voice disabled (`VITE_VOICE_ENABLED=false`) |
| Paid APIs / Vercel Hobby | **not used** | Vercel Hobby is non-commercial-only; a paid plan would be required |

Any provider can change free-tier terms. Monitor billing and quotas, and never
add a paid fallback automatically.

## 11. Remaining blockers before production

1. Apply migration `0003` to a verified backup of the production database and
   obtain explicit owner approval.
2. Provision Oracle/Supabase credentials and actually deploy, then verify
   TLS, same-origin login, order/payment/invoice flows and the health route.
3. Build and run the ARM64 image on the target host (Docker daemon was
   unavailable; see `ARM64_COMPATIBILITY_REPORT.md`).
4. Establish an independent, restored backup destination
   (`BACKUP_RUNBOOK.md`).
5. Confirm Supabase Free is acceptable for a production shop despite the
   inactivity pause and no SLA.
6. Voice is **deferred**, not verified: physical microphone acceptance and Tamil
   TTS remain `NOT TESTED`. Keep `VITE_VOICE_ENABLED=false` until
   `VOICE_ACCEPTANCE_REPORT.md` §7 passes.

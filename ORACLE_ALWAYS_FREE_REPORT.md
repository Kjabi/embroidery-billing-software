# Oracle Always Free Deployment Report

**Date:** 2026-11-07
**Scope:** whether the existing FastAPI backend can run on Oracle Cloud Always Free, and exactly what is verified vs blocked
**Environment used:** none. No Oracle tenancy, SSH key, instance or DNS name exists in this environment.
**Status:** **NOT TESTED / BLOCKED** — the design and local checks are complete; no Oracle resource was created.

> This report is a readiness assessment, not evidence of a deployment. Do not claim the backend
> is "running on Oracle" until the steps in §7 have actually been executed and verified.

## 1. Proposed topology

```text
Browser
  └─ HTTPS  https://<app-domain>/       → Caddy static SPA (/srv/app)
  └─ HTTPS  https://<app-domain>/api/*  → Caddy → FastAPI, 1 worker, 127.0.0.1:8000
                                            ├─ psycopg (TLS) → Supabase PostgreSQL session pooler
                                            └─ HTTPS → Supabase private Storage buckets
```

- Owner decision: the SPA is served by Caddy on the same origin (no Cloudflare Pages limit).
  See `CLOUDFLARE_DEPLOYMENT_COMPATIBILITY.md`.
- Voice is **disabled** in the production build (`VITE_VOICE_ENABLED=false`). No audio is sent
  to Oracle, and the lazy voice/WASM assets are never fetched while the panel is hidden.
- Optional `faster-whisper` is **excluded** from the production image by `deploy/Dockerfile`.
- The backend container is published only on the VM loopback; Caddy is the only public service.

## 2. Always Free allowances (as documented; re-check before provisioning)

| Resource | Documented Always Free allowance | Relevance |
|---|---|---|
| Ampere A1 `VM.Standard.A1.Flex` | A pooled monthly allowance that corresponds to roughly **2 OCPU / 12 GB RAM** for an Always Free tenancy | Target shape |
| AMD micro `VM.Standard.E2.1.Micro` | up to 2 instances | fallback if A1 capacity is unavailable |
| Block volume | 200 GB total | 50–100 GB boot volume is enough |
| Outbound transfer | 10 TB/month | shop traffic is far below this |
| Public IPv4 | included on free compute | do not create extra paid networking |

**Caution:** these figures have changed before (for example, the A1 allowance was reduced).
The console's **Always Free-eligible** label and the billing page are authoritative. Re-check
them on the day of provisioning. This report does not certify the current commercial terms.

## 3. What is verified locally

| Item | Result | Evidence |
|---|---|---|
| Backend runs as a single uvicorn process | PASS | full backend suite and isolated load tests |
| ARM64 Python wheels exist for the production dependency set | PASS | see `ARM64_COMPATIBILITY_REPORT.md` |
| `deploy/Dockerfile` excludes `faster-whisper` | PASS | `grep -v '^faster-whisper'` build step |
| Container binds loopback only behind Caddy | PASS (config) | `deploy/docker-compose.yml` ports `127.0.0.1:8000:8000` |
| Caddyfile sets TLS/HSTS/security headers | PASS (config) | `deploy/Caddyfile.example` |
| Caddy serves SPA and proxies `/api/*` | PASS (config) | `deploy/Caddyfile.example` |
| Compose mounts `frontend/dist` read-only | PASS (config) | `deploy/docker-compose.yml` |
| Backend health route exists and is public | PASS | `GET /health` and `GET /api/health`, runs `SELECT 1` |
| Health check updated to use `/api/health` | PASS (edit) | `deploy/Dockerfile` |
| `uvicorn --proxy-headers` set | PASS (config) | `deploy/Dockerfile` CMD |
| One worker enforced | PASS (config) | `--workers 1` |

## 4. What is NOT verified

| Item | Status | Why |
|---|---|---|
| ARM64 Docker image build | **NOT TESTED / BLOCKED** | Docker daemon unavailable; `docker build` cannot run |
| ARM64 runtime (boot, CPU, memory, PDF generation) | **NOT TESTED / BLOCKED** | no Oracle instance |
| Oracle A1 capacity availability | **UNKNOWN** | "out of host capacity" is common in popular regions |
| Caddy certificate issuance | **NOT TESTED** | needs a DNS name pointing at a live host |
| SPA served by Caddy + same-origin `/api` | **NOT TESTED** | no host; config reviewed only |
| Supabase connection from the VM | **NOT TESTED** | no staging project/credentials were used |
| Idle-reclamation behaviour for this workload | **UNKNOWN** | Oracle policy, not something we can test |
| Firewall/NSG correctness | **NOT TESTED** | no cloud account |
| Multi-worker behaviour | **NOT APPLICABLE** | one worker is deliberate |
| Backup destination independence | **FAIL** | see `BACKUP_RUNBOOK.md`; no ₹0 off-host target verified |

## 5. Risks that come with the ₹0 path

1. **Capacity shortages.** A1 launches can fail with "out of host capacity". Do not script a
   retry hammering loop; try another availability domain/region or use the AMD micro.
2. **Idle reclamation.** Oracle may reclaim an instance it considers idle over 7 days
   (low CPU/network/memory). This backend is low-traffic and may qualify. Oracle emails
   before reclaiming; keep backups and the deployment reproducible. Do not fabricate load to
   evade the policy.
3. **No SLA / no support.** Free tier has none. This is a real production limitation.
4. **Supabase Free pausing.** A Supabase Free project can pause after about 7 days of
   inactivity; the API will fail until resumed. This is unavoidable on ₹0 without a paid plan
   or an external keep-alive (which the brief disallows as a workaround without approval).
5. **Single worker.** Conversation state, login throttling and rate limits are process-local.
   Scaling out would break them until state is externalised.
6. **Co-located backups.** A VM loss destroys local backups. Only an off-host copy helps.
7. **AMD micro fallback is slow.** PDF generation and PBKDF2 login can be noticeably slower;
   not benchmarked on that shape.

## 6. Security requirements for the host

- SSH: key-only, restricted source IP if possible; never password-only.
- Open only 22 (admin IP), 80 and 443 (world). Do **not** open 8000, 5432 or 6379.
- `ufw` **and** the Oracle security list/NSG must both allow 80/443.
- `deploy/backend.env` and `deploy/systemd.env` must be `chmod 600`, owned by the deploy user,
  and never committed.
- `APP_SECRET_KEY` from `openssl rand -hex 32`.
- Remove `ADMIN_INITIAL_PASSWORD` after first boot.
- The Supabase **service-role** key stays server-side only; never a `VITE_` variable.
- Enable `unattended-upgrades`; configure Docker log rotation.
- Add 2 GB swap to absorb PDF-generation spikes (not a substitute for RAM).

## 7. Exact steps still to execute (manual, owner-approved)

1. Create an Always Free tenancy in a region near Madurai/India if available.
2. Create `VM.Standard.A1.Flex` 2 OCPU / 12 GB, Ubuntu 24.04 ARM64, 50–100 GB boot volume;
   confirm the **Always Free-eligible** label.
3. Add the SSH public key; never enable password-only login.
4. Restrict ingress to 22/80/443 as above.
5. Install Docker Engine + Compose plugin for arm64; enable at boot.
6. Add swap, `ufw`, `unattended-upgrades`.
7. Point a DNS name you control (existing domain or a free DDNS subdomain) at the public IP.
8. Copy the repository to `/opt/embroidery`; create `deploy/backend.env` (600) and
   `deploy/systemd.env` (600) with `BACKEND_DOMAIN`.
9. Build the SPA: `cd frontend && npm ci && VITE_API_BASE_URL=/api VITE_VOICE_ENABLED=false npm run build`.
10. Build and start: `docker compose -f deploy/docker-compose.yml up -d --build`.
11. Verify: `curl -fsS https://<domain>/` returns the SPA, `curl -fsS https://<domain>/api/health`
    returns `{"status":"ok"}`, then log in, create an order, take a payment, generate a PDF, and
    repeat with a second admin session.
12. Install `deploy/embroidery-backend.service`, enable it, and confirm it survives reboot.
13. Record actual CPU/RAM/latency on this host (see §8) and update this report.

## 8. Measurements that must replace the NOT TESTED rows

When the host exists, record:

- `docker build` result and image size on ARM64.
- Cold-start time and RSS after login + 10 orders.
- PDF generation time (p50/p95) on A1 and, if used, on the AMD micro.
- Login latency (PBKDF2) on A1.
- `pg_dump`/`pg_restore` timings to the chosen backup destination.
- Confirmation that `/api/health` is reachable through Caddy and that `/api` is not exposed on
  port 8000 from the internet.

## 9. Verdict

- **Design and local configuration: PASS.**
- **Oracle ARM64 deployment: NOT TESTED / BLOCKED** (no tenancy, no Docker daemon, no DNS).
- **Production suitability of the free tier: CONDITIONAL** — acceptable only if the owner
  accepts capacity shortages, idle reclamation, no SLA, Supabase pausing and single-worker
  state. These are business decisions, not engineering fixes.

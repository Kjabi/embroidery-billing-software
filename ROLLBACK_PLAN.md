# Rollback Plan — Lalitha's Apparel

**Date:** 2026-11-08
**Status:** prepared, **NEVER EXERCISED against production**. The restore mechanics were drilled on
isolated SQLite and PostgreSQL copies (`BACKUP_RESTORE_REPORT.md`); the application rollback below
has not been performed.
**Primary target:** Vercel (Services: `web` + `api`).
**Applies to:** the Vercel deployment, the Oracle/Caddy fallback, database migrations `0003` /
`0004`, and DNS/TLS.

> The guiding rule: **prefer rolling forward with a fix over restoring the database.** A database
> restore discards every write made after the snapshot. Only restore when data integrity is
> actually compromised.

## 1. Rollback triggers

Roll back (or freeze writes) if any of these occur after a release:

- login or session validation fails for all users;
- order/payment/delivery writes fail or produce duplicates;
- invoice numbers duplicate, skip unpredictably, or the PDF is wrong;
- the health check fails repeatedly through the host;
- a migration errors midway or leaves an unexpected schema;
- a security regression is found in the new build;
- a performance regression makes the app unusable.

A single cosmetic issue is **not** a rollback trigger; fix forward.

## 2. Decision authority and timing

| Situation | Who decides | Target |
|---|---|---|
| New build is broken, DB intact | operator on call, notify owner | roll back app within 15 min |
| Migration failed cleanly (transaction aborted) | operator + owner | stop, assess, fix forward or reverse |
| Data corruption suspected | owner only | freeze writes, snapshot, restore |
| Security incident | owner + operator | rotate secrets, roll back, investigate |

No rollback of production data happens without owner approval and a fresh snapshot.

## 3. Preconditions for any reversible release (do these **before** deploying)

1. Record the current Vercel deployment URL/ID and the current git commit.
2. Take a verified database dump (`BACKUP_RUNBOOK.md`) and confirm it restores into a throwaway DB.
3. Confirm the previous Vercel deployment is still listed and promotable.
4. Note the current `invoice_sequences.next_number` and max invoice number.
5. Confirm the new schema is **additive** (see §6). If not, a plain app rollback is unsafe.

## 4. Frontend + API rollback on Vercel (fast, low risk)

Vercel keeps every deployment; rolling back the app does not touch the database.

### 4.1 Promote the previous deployment (dashboard)

1. Open **Vercel → Project → Deployments**.
2. Find the last known-good **Production** deployment.
3. Use **Promote to Production** (or **Rollback**) on that deployment.
4. Confirm the new production URL serves the old bundle hash.

### 4.2 Promote the previous deployment (CLI)

```bash
npx vercel ls
npx vercel promote <previous-deployment-url>
# or, when the project is linked and you know the previous deployment:
npx vercel rollback <previous-deployment-url>
```

Then verify:

```bash
curl -fsS https://<domain>/api/health
curl -fsS https://<domain>/ | grep -qi '<div id="root">' && echo 'SPA OK'
```

### 4.3 Oracle/Caddy fallback

1. Restore the previous `dist/` archive to `/srv/app` (atomic swap: copy to `dist.new`, then move).
2. Re-pin the previous backend image tag and run `docker compose up -d --no-build`.
3. Reload Caddy only if the config changed; hard-refresh a browser and confirm the old bundle hash.

Post-check: login, one read-only page, one order read. No database change is expected.

## 5. Backend rollback

On Vercel, the Python `api` service is versioned with the deployment, so §4 rolls back both web
and API together. If only the API must change, promote a deployment whose `api` code is known-good.

Fallback (Oracle/Caddy):

```bash
cd /opt/embroidery
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml up -d --no-build   # previous explicitly tagged image
docker compose -f deploy/docker-compose.yml logs --tail=100 backend
curl -fsS https://<domain>/api/health
```

If images were built locally with `latest`, retag releases explicitly (for example
`lalithas-backend:2026-11-08`) so a rollback target exists.

Compatibility: migrations `0003` and `0004` are additive (`CREATE TABLE/INDEX/COLUMN IF NOT
EXISTS`). A previous application version that does not read the new columns continues to work.
The exception is any code that *requires* `invoice_sequences`; if the previous build allocates
invoice numbers differently, confirm it still produces unique numbers on the new schema before
declaring the rollback complete.

## 6. Database rollback

### 6.1 Reverse `0004` (performance only — safe)

`0004` only adds indexes. Reversing it loses nothing but speed:

```sql
DROP INDEX CONCURRENTLY IF EXISTS public.idx_orders_customer_id_id_desc;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_orders_order_date_id;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_orders_balance_positive;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_order_measurements_order_id;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_transactions_date_id;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_transactions_income_date;
```

Run outside a transaction. Not required unless an index causes a problem.

### 6.2 Reverse `0003` (destructive — last resort)

`0003` adds `admin_sessions`, `invoice_sequences`, `orders.invoice_snapshot`,
`orders.create_request_id`, `transactions.idempotency_key` and their indexes. Reversing it
**destroys session state and idempotency history**:

```sql
-- ONLY after a verified snapshot and owner approval
DROP INDEX IF EXISTS public.ux_orders_create_request_id;
DROP INDEX IF EXISTS public.ux_transactions_idempotency_key;
DROP INDEX IF EXISTS public.idx_admin_sessions_active_expiry;
DROP TABLE IF EXISTS public.admin_sessions;
DROP TABLE IF EXISTS public.invoice_sequences;
ALTER TABLE public.orders DROP COLUMN IF EXISTS invoice_snapshot;
ALTER TABLE public.orders DROP COLUMN IF EXISTS create_request_id;
ALTER TABLE public.transactions DROP COLUMN IF EXISTS idempotency_key;
```

Consequences: all admins are logged out; duplicate-request protection for orders/payments is
lost; invoice snapshot text is lost (PDFs regenerate from business data). Prefer fixing forward.

### 6.3 Restore from a logical dump (data corruption)

Do **not** restore over the live database in place. Restore into a new database, verify, then
repoint `SUPABASE_DATABASE_URL` in Vercel and redeploy.

```bash
createdb -h <host> -U <user> restore_check
pg_restore -h <host> -U <user> -d restore_check --no-owner --no-privileges dump.dump
psql -h <host> -U <user> -d restore_check -c "SELECT count(*) FROM orders;"
psql -h <host> -U <user> -d restore_check -c "SELECT count(*) FROM transactions;"
psql -h <host> -U <user> -d restore_check -c "SELECT * FROM invoice_sequences;"
# compare with the pre-incident counts, then update the env var and redeploy
```

For Supabase, automated backup/PITR availability depends on the plan — **verify it before
relying on it**. The free path in this project is a logical dump taken by the operator.

**Data-loss trade-off:** a restore loses every order/payment/customer created after the
snapshot. Tell the owner the exact cutoff before proceeding, and reconcile manually if needed.

## 7. DNS / TLS rollback

- Keep the previous DNS record until the new host passes verification (low TTL, e.g. 300 s,
  before a cutover).
- Vercel-managed TLS: if the domain fails, remove and re-add it in the project, fix the DNS
  record, and wait for verification. Do not disable HTTPS.
- Fallback host: if TLS fails, point DNS back to the old host. Let's Encrypt rate limits mean
  repeated failed issuance attempts should stop and be diagnosed, not retried in a loop.

## 8. Post-rollback verification

- [ ] `/api/health` is green through the host.
- [ ] login, logout, and old-token rejection behave correctly.
- [ ] create an order, take a payment, generate a PDF.
- [ ] invoice numbers are unique and correctly sequenced.
- [ ] no duplicate rows from replayed requests.
- [ ] cloud backup runs successfully after the rollback (`/api/backup` returns 503 only when
      storage is genuinely unconfigured).
- [ ] the incident is written down with timestamps, cause, action, and data-loss window.

## 9. Communication

1. Tell the owner immediately: what is broken, what is frozen, what will be lost.
2. Freeze writes (promote a maintenance build or revoke database credentials) if corruption is
   suspected.
3. After recovery, send a short summary: cause, fix/rollback, verification, follow-up.

## 10. Recovery objectives (estimates — not measured)

| Metric | Estimate | Basis |
|---|---|---|
| Vercel app rollback | < 5 min | promote the previous deployment |
| Fallback app rollback | < 15 min | image rebuild not required |
| Frontend-only rollback | < 5 min | Vercel deployment promotion |
| Logical restore | 30–90 min | depends on size/network; drill was local |
| Data-loss window | since last verified dump | schedule in `BACKUP_RUNBOOK.md` |

These are planning numbers, not guarantees.

## 11. What cannot be rolled back

- Messages already sent to customers (none are sent by the app).
- PDFs already downloaded by customers.
- Writes made after the chosen snapshot if a restore is used.
- Deleted storage objects (best-effort deletion is immediate).

## 12. Verdict

- **Vercel app rollback: designed, NOT TESTED.**
- **Fallback app rollback: designed, NOT TESTED.**
- **`0004` reversal: safe and simple, NOT TESTED.**
- **`0003` reversal: destructive; discouraged.**
- **Restore mechanics: drilled on isolated copies, PASS; production restore NOT TESTED.**

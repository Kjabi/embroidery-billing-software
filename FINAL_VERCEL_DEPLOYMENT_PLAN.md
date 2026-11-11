# Final Vercel Deployment Plan

**Status:** Preview-only plan; no deployment performed

Frontend: Vite, root `frontend/`, install `npm ci`, build `npm run build`,
output `dist`. Use `VITE_API_BASE_URL=/api` only after a single-project API
route is validated; otherwise use the separately hosted backend URL.

Configure backend-only database, app-secret, Supabase, bucket, CORS, and voice
variables separately for Preview and Production. Never put service-role keys
in `VITE_*`.

Preview sequence: connect the private repository, use isolated/staging
Supabase resources, deploy Preview, check health/login/CRUD/payments/invoices/
uploads/headers/CORS/cold starts, run responsive E2E, then approve production.
No production deployment or migration is authorized by this report.

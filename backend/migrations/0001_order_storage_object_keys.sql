-- Run once against the Supabase PostgreSQL database before deploying this version.
-- Additive and idempotent: existing order records and legacy drawing_path values are preserved.
BEGIN;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS drawing_object_key text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS invoice_object_key text;
COMMIT;

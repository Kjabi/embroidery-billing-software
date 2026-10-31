-- Additive, non-destructive migration. Apply to a development/Preview database first.
-- Business records remain in PostgreSQL; PDFs and reference-image bytes are never stored here.
BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_sessions (
    id text PRIMARY KEY,
    admin_id integer NOT NULL REFERENCES public.admin(id) ON DELETE CASCADE,
    expires_at bigint NOT NULL,
    revoked boolean NOT NULL DEFAULT false,
    created_at text NOT NULL DEFAULT now()::text
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_active_expiry
    ON public.admin_sessions (admin_id, expires_at)
    WHERE revoked = false;

CREATE TABLE IF NOT EXISTS public.invoice_sequences (
    year integer PRIMARY KEY,
    next_number integer NOT NULL CHECK (next_number > 0)
);

-- Seed the current-year counter from existing invoices without changing them.
INSERT INTO public.invoice_sequences (year, next_number)
SELECT
    EXTRACT(YEAR FROM CURRENT_DATE)::integer,
    COALESCE(MAX(
        CASE WHEN invoice_number ~ '^INV-[0-9]{4}-[0-9]+$'
        THEN substring(invoice_number FROM '([0-9]+)$')::integer END
    ), 0) + 1
FROM public.orders
ON CONFLICT (year) DO NOTHING;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS invoice_snapshot text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS create_request_id text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_create_request_id
    ON public.orders (create_request_id)
    WHERE create_request_id IS NOT NULL;

ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_idempotency_key
    ON public.transactions (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

COMMIT;

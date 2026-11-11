-- Performance-only indexes for the authenticated read paths.
-- Apply manually to a development/preview PostgreSQL database after reviewing
-- EXPLAIN (ANALYZE, BUFFERS). This migration is intentionally not auto-applied.
--
-- CONCURRENTLY statements must run outside a transaction block.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_customer_id_id_desc
    ON public.orders (customer_id, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_order_date_id
    ON public.orders (order_date, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_balance_positive
    ON public.orders (balance)
    WHERE balance > 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_measurements_order_id
    ON public.order_measurements (order_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_date_id
    ON public.transactions (date, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_income_date
    ON public.transactions (date)
    WHERE type = 'INCOME';

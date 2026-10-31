-- Additive, idempotent migration for optional private order reference images.
ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS reference_image_object_key text NULL;

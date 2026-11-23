-- contact_messages.source: website vs institute enquiries.
-- Idempotent: safe to run on a database that already has this change.
-- Moved from scripts/contact_messages_source.sql (already applied by hand on some environments).
-- migrate:skip-if: select exists (select 1 from information_schema.columns where table_schema='public' and table_name='contact_messages' and column_name='source') and exists (select 1 from pg_constraint where conname='contact_messages_source_check') and exists (select 1 from pg_indexes where indexname='contact_messages_source_idx') as ok

ALTER TABLE public.contact_messages
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'website';

-- Steps 2 and 3 constrain the column to the values the API accepts, so a typo in
-- a future caller fails loudly at write time instead of silently creating a
-- third category the admin filter does not know about.
--
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so drop-then-add is the
-- idempotent form. Deliberately NOT a DO/$$ block: dollar-quoted bodies are the
-- other thing simple SQL consoles mangle.

-- Step 2 -- clear any previous version of the constraint (no-op on a fresh DB).
ALTER TABLE public.contact_messages
    DROP CONSTRAINT IF EXISTS contact_messages_source_check;

-- Step 3 -- apply the constraint.
ALTER TABLE public.contact_messages
    ADD CONSTRAINT contact_messages_source_check
    CHECK (source IN ('website', 'institute'));

-- Step 4 -- the admin Reports tab filters on this; index it.
CREATE INDEX IF NOT EXISTS contact_messages_source_idx
    ON public.contact_messages (source);

-- Step 5 -- refresh the PostgREST schema cache. Without this the API keeps
-- reporting the column as missing (PGRST204) until PostgREST restarts.
NOTIFY pgrst, 'reload schema';

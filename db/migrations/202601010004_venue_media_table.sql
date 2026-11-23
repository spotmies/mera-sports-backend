-- venue_media: admin-managed photos and videos for the venue page.
-- Idempotent: safe to run on a database that already has this change.
-- Moved from scripts/venue_media_migration.sql (already applied by hand on some environments).
-- migrate:skip-if: select to_regclass('public.venue_media') is not null as ok

create table if not exists public.venue_media (
    id            uuid primary key default gen_random_uuid(),
    -- 'photo' rows hold an uploaded image; 'video' rows hold a YouTube/Vimeo or
    -- direct link. Videos are links rather than uploads on purpose: the API's
    -- JSON body cap is 15 MB and base64 inflates by a third, so an uploaded
    -- promo video could not exceed ~11 MB — far too small to be usable.
    kind          text not null check (kind in ('photo', 'video')),
    url           text not null,
    -- Videos only, and optional: a custom poster image. When absent the API
    -- derives a YouTube thumbnail from the url.
    thumbnail_url text,
    caption       text,
    -- Display order within a section. Lower first; ties fall back to created_at.
    sort_order    integer not null default 0,
    -- Lets the admin hide an item without losing it.
    is_active     boolean not null default true,
    created_at    timestamptz not null default now(),
    created_by    uuid
);

-- The public read is always "active rows of one kind, in display order".
create index if not exists idx_venue_media_kind_order
    on public.venue_media (kind, sort_order, created_at)
    where is_active;

-- Grant the PostgREST API role the DML it needs. Guarded so the script never
-- aborts if the role is absent/renamed in a given environment (RLS is not used
-- on this table — authorization stays in the API middleware, as elsewhere).
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'merasports_api') then
        grant select, insert, update, delete on public.venue_media to merasports_api;
        raise notice 'Granted DML on public.venue_media to merasports_api';
    else
        raise notice 'Role merasports_api not found — GRANT skipped. Grant manually to your PostgREST role.';
    end if;
end $$;

-- Make PostgREST expose the new table immediately (no restart needed).
notify pgrst, 'reload schema';

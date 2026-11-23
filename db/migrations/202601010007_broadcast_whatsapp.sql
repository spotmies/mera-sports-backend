-- Broadcast to WhatsApp: broadcast_logs lifecycle columns + broadcast_recipients.
-- Idempotent: safe to run on a database that already has this change.
-- Moved from scripts/broadcast_whatsapp_migration.sql (already applied by hand on some environments).
-- migrate:skip-if: select to_regclass('public.broadcast_recipients') is not null and exists (select 1 from information_schema.columns where table_schema='public' and table_name='broadcast_logs' and column_name='status') and exists (select 1 from pg_constraint where conname='broadcast_logs_status_check') as ok

create table if not exists public.broadcast_logs (
    id             uuid primary key default gen_random_uuid(),
    title          text not null,
    message        text not null,
    recipient_type text not null,
    target_count   integer default 0,
    success_count  integer default 0,
    failure_count  integer default 0,
    image_url      text,
    meta           jsonb default '{}'::jsonb,
    created_at     timestamptz default now()
);

-- ------------------------------------------------------------
-- 1. Extend broadcast_logs
-- ------------------------------------------------------------
-- A broadcast is no longer instantaneous: sends are throttled and run in the
-- background, so the row needs a lifecycle (`status`) and an audit trail of who
-- sent it, not just the counters it finished with.
alter table public.broadcast_logs
    add column if not exists status         text        not null default 'completed',
    add column if not exists channels       text[]      not null default array['in_app']::text[],
    add column if not exists template_name  text,
    add column if not exists event_id       integer,
    add column if not exists category       text,
    add column if not exists created_by     uuid,
    add column if not exists created_by_name text,
    add column if not exists started_at     timestamptz,
    add column if not exists completed_at   timestamptz,
    add column if not exists error          text;

-- Existing rows predate WhatsApp and predate the status column; the defaults
-- above already describe them correctly (completed, in-app only).

-- 'queued'    accepted, worker has not started
-- 'sending'   worker is walking the recipient list
-- 'completed' every recipient reached a terminal state
-- 'failed'    the broadcast itself blew up (bad template, no credentials)
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'broadcast_logs_status_check'
    ) then
        alter table public.broadcast_logs
            add constraint broadcast_logs_status_check
            check (status in ('queued', 'sending', 'completed', 'failed'));
    end if;
end $$;

create index if not exists idx_broadcast_logs_created_at
    on public.broadcast_logs (created_at desc);

-- ------------------------------------------------------------
-- 2. broadcast_recipients
-- ------------------------------------------------------------
create table if not exists public.broadcast_recipients (
    id            uuid primary key default gen_random_uuid(),
    broadcast_id  uuid not null references public.broadcast_logs (id) on delete cascade,

    -- user_id is nullable on purpose: team-mates listed in player_teams.members
    -- are real recipients with a real mobile number but may not have a user row.
    user_id       uuid,
    name          text,
    mobile        text,
    source        text not null default 'player',   -- 'player' | 'team_member'
    team_name     text,

    -- pending    queued, not yet attempted
    -- sent       Meta accepted the message (has wa_message_id)
    -- delivered  handset acknowledged  (status webhook)
    -- read       recipient opened it   (status webhook)
    -- failed     rejected at send time or by the status webhook
    -- skipped    never attempted (unusable mobile number)
    status        text not null default 'pending',
    wa_message_id text,
    error         text,
    attempts      integer not null default 0,
    sent_at       timestamptz,
    updated_at    timestamptz not null default now(),
    created_at    timestamptz not null default now()
);

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'broadcast_recipients_status_check'
    ) then
        alter table public.broadcast_recipients
            add constraint broadcast_recipients_status_check
            check (status in ('pending', 'sent', 'delivered', 'read', 'failed', 'skipped'));
    end if;
end $$;

-- The three access patterns: list a broadcast's recipients, filter that list by
-- status (the "show me the failures" drill-down), and resolve the inbound status
-- webhook, which knows only Meta's message id.
create index if not exists idx_broadcast_recipients_broadcast
    on public.broadcast_recipients (broadcast_id);

create index if not exists idx_broadcast_recipients_status
    on public.broadcast_recipients (broadcast_id, status);

create unique index if not exists idx_broadcast_recipients_wa_message_id
    on public.broadcast_recipients (wa_message_id)
    where wa_message_id is not null;

-- One row per person per broadcast. A player registered in three categories of
-- the same event is one recipient, and a retry must update their row rather
-- than append a second one.
create unique index if not exists idx_broadcast_recipients_unique_mobile
    on public.broadcast_recipients (broadcast_id, mobile)
    where mobile is not null;

-- ------------------------------------------------------------
-- 3. Grants for the PostgREST API role
-- ------------------------------------------------------------
-- Guarded so the script never aborts if the role is absent/renamed in a given
-- environment. RLS is not used on these tables — authorization stays in the API
-- middleware (verifyAdmin), consistent with the rest of the Railway migration.
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'merasports_api') then
        grant select, insert, update, delete on public.broadcast_logs       to merasports_api;
        grant select, insert, update, delete on public.broadcast_recipients to merasports_api;
        raise notice 'Granted DML on broadcast_logs + broadcast_recipients to merasports_api';
    else
        raise notice 'Role merasports_api not found — GRANT skipped. Grant manually to your PostgREST role.';
    end if;
end $$;

-- Make PostgREST expose the new table and columns immediately (no restart).
notify pgrst, 'reload schema';

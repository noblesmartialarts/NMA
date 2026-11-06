-- ============================================================
-- Noble's Martial Arts CRM — Supabase Schema
-- Run this entire file in Supabase → SQL Editor → New query
-- ============================================================

-- Main CRM data table (stores the full DB as JSON)
-- Stage 1: single-document approach for zero-friction migration
-- Stage 2: normalize into relational tables (see system docs)
CREATE TABLE IF NOT EXISTS crm_data (
  id          TEXT PRIMARY KEY DEFAULT 'main',
  data        JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE crm_data ENABLE ROW LEVEL SECURITY;

-- Stage 1 policy: open access (no login required yet)
-- Replace this with user-scoped policies when you add auth
CREATE POLICY "Allow full access"
  ON crm_data
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Auto-update timestamp on every write
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crm_data_updated_at
  BEFORE UPDATE ON crm_data
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Insert a placeholder row so upsert always has something to update
INSERT INTO crm_data (id, data)
VALUES ('main', '{}')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Done. Your database is ready.
-- ============================================================

-- ── Workshop facelift (Nov 2026) ──
alter table public.workshop_leads
  add column if not exists session_time text,
  add column if not exists location text,
  add column if not exists expected_count integer,
  add column if not exists actual_count integer,
  add column if not exists payment_status text default 'Unpaid',
  add column if not exists follow_up_date date,
  add column if not exists series_name text,
  add column if not exists session_number integer;

create table if not exists public.workshop_participants (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshop_leads(id) on delete cascade,
  full_name text not null,
  role text not null default 'Teen',
  age integer,
  paired_with text,
  email text,
  phone text,
  emergency_contact text,
  waiver_signed boolean not null default false,
  media_consent text not null default 'Unknown' check (media_consent in ('Unknown','Yes','No')),
  adult_class_interest boolean not null default false,
  attended boolean not null default false,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists workshop_participants_workshop_id_idx on public.workshop_participants(workshop_id);
alter table public.workshop_participants enable row level security;
-- No policies: only reachable through the signed-in crm-db function (service key).

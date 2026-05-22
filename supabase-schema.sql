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

-- Per-service schemas on one Postgres instance in dev. In prod each
-- schema moves to its own instance without code change; the DATABASE_URL
-- shifts and the CREATE SCHEMA becomes CREATE DATABASE.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE SCHEMA IF NOT EXISTS document_service;
CREATE SCHEMA IF NOT EXISTS materials_service;
CREATE SCHEMA IF NOT EXISTS orchestrator_service;
CREATE SCHEMA IF NOT EXISTS iam_service;

-- =========================================================================
-- document-service
-- =========================================================================
CREATE TABLE document_service.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  page_count INT,
  uploaded_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Content-addressable idempotency: same file re-uploaded → same row.
  UNIQUE (org_id, sha256)
);
CREATE INDEX ON document_service.documents (org_id, created_at DESC);

-- =========================================================================
-- materials-service
-- =========================================================================
CREATE TYPE materials_service.material_kind AS ENUM ('concrete', 'steel', 'timber', 'insulation', 'other');
CREATE TYPE materials_service.extraction_status AS ENUM ('pending', 'running', 'staged', 'live', 'failed', 'superseded', 'needs_review');
CREATE TYPE materials_service.provenance_confidence AS ENUM ('high', 'medium', 'low');
CREATE TYPE materials_service.provenance_method AS ENUM ('vision-llm', 'text-llm', 'manual', 'derived');

CREATE TABLE materials_service.materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  kind materials_service.material_kind NOT NULL,
  live_extraction_id UUID,               -- FK set after extraction goes live
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE materials_service.extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL,             -- soft ref to document_service.documents.id
  material_id UUID REFERENCES materials_service.materials(id) ON DELETE SET NULL,
  version_key TEXT NOT NULL,
  status materials_service.extraction_status NOT NULL DEFAULT 'pending',
  prompt_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  extractor_name TEXT NOT NULL,
  epd_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_live BOOLEAN NOT NULL DEFAULT FALSE,
  superseded_by UUID REFERENCES materials_service.extractions(id) ON DELETE SET NULL,
  processing_lock_token TEXT,
  processing_lock_expires_at TIMESTAMPTZ,
  cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency on the 7-tuple: same input + same config = same row.
  UNIQUE (version_key)
);
CREATE INDEX ON materials_service.extractions (document_id);
CREATE INDEX ON materials_service.extractions (material_id);
CREATE INDEX ON materials_service.extractions (status);
-- At most one live extraction per material at a time (see ARCHITECTURE.md §3).
CREATE UNIQUE INDEX one_live_per_material
  ON materials_service.extractions (material_id) WHERE is_live IS TRUE;

CREATE TABLE materials_service.provenance_snippets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id UUID NOT NULL REFERENCES materials_service.extractions(id) ON DELETE CASCADE,
  field_path TEXT NOT NULL,              -- e.g. 'lifeCycle.A1-A3.gwpTotal'
  page_number INT NOT NULL,
  snippet TEXT NOT NULL,
  confidence materials_service.provenance_confidence NOT NULL,
  method materials_service.provenance_method NOT NULL,
  bounding_box JSONB
);
CREATE INDEX ON materials_service.provenance_snippets (extraction_id);
CREATE INDEX ON materials_service.provenance_snippets (field_path);
CREATE INDEX ON materials_service.provenance_snippets (confidence)
  WHERE confidence IN ('medium', 'low');

CREATE TABLE materials_service.extraction_events (
  id BIGSERIAL PRIMARY KEY,
  extraction_id UUID NOT NULL,
  event_type TEXT NOT NULL,              -- 'started', 'guardrail.rejected', ...
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor TEXT NOT NULL,                   -- 'orchestrator', 'human:<user_id>', ...
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON materials_service.extraction_events (extraction_id, created_at);

-- =========================================================================
-- orchestrator-service
-- =========================================================================
CREATE TYPE orchestrator_service.workflow_status AS ENUM ('pending', 'running', 'completed', 'failed', 'paused_budget', 'needs_review');
CREATE TYPE orchestrator_service.step_status AS ENUM ('pending', 'running', 'completed', 'failed', 'skipped');

CREATE TABLE orchestrator_service.workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  kind TEXT NOT NULL,                    -- 'extract-epd', 'query-materials'
  input_ref TEXT NOT NULL,               -- e.g. document_id for extract flows
  status orchestrator_service.workflow_status NOT NULL DEFAULT 'pending',
  definition JSONB NOT NULL,             -- serialized WorkflowDefinition
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  deadline_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON orchestrator_service.workflows (org_id, created_at DESC);
CREATE INDEX ON orchestrator_service.workflows (status) WHERE status NOT IN ('completed', 'failed');

CREATE TABLE orchestrator_service.workflow_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES orchestrator_service.workflows(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,
  agent TEXT NOT NULL,
  fan_index INT NOT NULL DEFAULT 0,      -- for fan-out steps, 0..N-1
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  status orchestrator_service.step_status NOT NULL DEFAULT 'pending',
  failure_reason TEXT,
  attempts INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON orchestrator_service.workflow_steps (workflow_id, step_name);
CREATE INDEX ON orchestrator_service.workflow_steps (status)
  WHERE status IN ('pending', 'running');

CREATE TABLE orchestrator_service.cost_ledger (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID NOT NULL,
  workflow_id UUID,
  step_id UUID,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_tokens INT NOT NULL,
  cache_read_tokens INT NOT NULL DEFAULT 0,
  cache_write_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL,
  cost_usd NUMERIC(12, 6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON orchestrator_service.cost_ledger (org_id, created_at);
CREATE INDEX ON orchestrator_service.cost_ledger (workflow_id);
CREATE INDEX ON orchestrator_service.cost_ledger (provider, model_id, created_at);

CREATE TABLE orchestrator_service.budget_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  scope TEXT NOT NULL,                   -- 'org', 'user', 'workflow'
  limit_usd NUMERIC(12, 6) NOT NULL,
  period TEXT NOT NULL,                  -- 'daily', 'monthly', 'lifetime'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, scope, period)
);

-- =========================================================================
-- iam-service (minimal — enough for a valid JWT in dev)
-- =========================================================================
CREATE TABLE iam_service.orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  daily_budget_usd NUMERIC(12, 6) NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE iam_service.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES iam_service.orgs(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE iam_service.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES iam_service.orgs(id) ON DELETE CASCADE,
  hash TEXT NOT NULL UNIQUE,             -- sha256(clear text)
  scopes TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[],
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed one dev org so the API works out-of-the-box.
INSERT INTO iam_service.orgs (id, name, daily_budget_usd)
VALUES ('00000000-0000-0000-0000-000000000001', 'dev-org', 100)
ON CONFLICT DO NOTHING;

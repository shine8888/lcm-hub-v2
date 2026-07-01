# Database

The schema is defined verbatim in [`deploy/postgres/init.sql`](../deploy/postgres/init.sql). This doc explains **why** each table looks the way it does — for a schema review or a scale-up conversation.

## Layout

Four schemas on one Postgres instance in dev:

- `document_service` — inbound PDFs + storage refs
- `materials_service` — extraction rows, provenance, audit
- `orchestrator_service` — workflows, steps, cost, budgets
- `iam_service` — orgs, users, api keys

**Foreign keys don't cross schemas.** Cross-service references are stored as UUIDs; the referent lives in another service's DB. In dev that DB is the same instance, so `psql` can join anyway, but the code respects the boundary. In prod each schema moves to its own instance without a code change (only `DATABASE_URL` shifts).

## `document_service.documents`

Content-addressable idempotency by `UNIQUE (org_id, sha256)`. Uploading the same PDF twice returns the same document row — the client didn't need an idempotency key, the hash IS the key.

- `sha256` is enforced at insert. The upload endpoint computes it before writing to MinIO; a mismatch after upload marks the row `poisoned`.
- `page_count` is nullable — filled in by document-service on upload (via `pdfinfo`) so downstream agents don't recompute it per step.
- Indexed on `(org_id, created_at DESC)` for the tenant timeline.

## `materials_service.extractions`

The most-worked-on table in the schema. Three invariants:

**1. Version-key idempotency.** `UNIQUE (version_key)` collapses retries with identical config to one row. See `packages/base-framework/src/persistence/version-key.ts` — the key is `sha256(document_id ∥ revision ∥ extractor_name ∥ model_id ∥ prompt_version ∥ schema_version ∥ chunk_config)`. Any change to any of those seven produces a NEW row; the old one survives.

**2. At most one live extraction per material.** Enforced by a **partial UNIQUE index** — `CREATE UNIQUE INDEX one_live_per_material ON extractions (material_id) WHERE is_live IS TRUE`. Postgres will refuse to insert a second `is_live = true` row for the same material. Promotion of a staged extraction is a transaction: `UPDATE ... SET is_live = false, superseded_by = new_id WHERE material_id = X AND is_live = true; UPDATE ... SET is_live = true WHERE id = new_id;`.

**3. Processing lock prevents dual-writer races.** Two orchestrator instances that both pick up the same step both `UPDATE ... SET processing_lock_token = uuid_generate_v4(), processing_lock_expires_at = NOW() + interval '15 min' WHERE id = $1 AND (processing_lock_token IS NULL OR processing_lock_expires_at < NOW()) RETURNING processing_lock_token`. Only one row is affected; the loser gets zero rows and knows to skip.

`epd_data` is JSONB. It's validated by the shared Zod schema (`epdPayload` in base-framework) at both write and read. We don't use JSONB indexes on `epd_data` itself — filtering-by-payload happens against the `provenance_snippets` table + strong-typed columns like `compressive_strength_mpa` in a materialized view (out of scope for this repo).

## `materials_service.provenance_snippets`

Provenance is a first-class table, not a JSONB blob. Rationale in [`ARCHITECTURE.md` §4.2](./ARCHITECTURE.md).

- One row per extracted field, keyed by `field_path` (`lifeCycle.A1-A3.gwpTotal`, `compressiveStrength.valueMpa`, etc).
- Indexed on `extraction_id` (for detail-page rendering — pull all snippets for a product), on `field_path` (for the "show every A1-A3 provenance in the corpus" analytics query), and on `confidence` as a **partial index** — `CREATE INDEX ... WHERE confidence IN ('medium', 'low')` — because the interesting query is "surface everything that's low-confidence," never "surface high-confidence rows."
- `bounding_box` is JSONB nullable. Vision LLMs sometimes return it, text-parse extraction doesn't. Present when available, absent otherwise — no synthetic default.

## `materials_service.extraction_events`

**Append-only.** Never UPDATE, never DELETE. The audit trail of every state transition, guardrail decision, LLM call, and human review touch.

- `event_type` is a text column, not an enum, on purpose — we don't want a schema migration every time a new observability signal is added.
- Retention handled at partition level. Partition `extraction_events` by month; drop old partitions on a schedule (out of scope for the vertical slice, but the shape is ready — every row has `created_at`, and BIGSERIAL is monotonic).
- `payload` is JSONB, unrestricted. Storing the full context is a feature — the audit table doubles as an "everything about this extraction" snapshot.

## `orchestrator_service.workflows`, `workflow_steps`

The engine is stateless; state lives here.

- `workflows.definition` is JSONB — the WorkflowDefinition serialized. This means a prompt/step-order change (a new v2 workflow shape) doesn't invalidate historical rows: they still carry their own definition and can be replayed.
- `workflow_steps.attempts` counter + the state machine (`pending → running → completed | failed | skipped`) drives retries. Retry limits are per-step (`step.maxAttempts` in the definition), not global.
- `workflow_steps.status` has a partial index on `WHERE status IN ('pending', 'running')` — the orchestrator's "what's ready to advance?" query only cares about active rows; the index scans milliseconds even at 100k+ historical rows.
- **Fan-out is materialized up-front.** When a definition says `fanOut: { count: 3 }`, `createWorkflow` inserts three rows with `fan_index = 0..2`. No dynamic step insertion, no orphan detection — just N rows the engine treats as N independent units of work.

## `orchestrator_service.cost_ledger`

Every LLM call, one row. Column layout matches vendor billing exactly (input, cache-read, cache-write, output tokens; USD).

- **BIGSERIAL** PK because BIGSERIAL is cheap, monotonic, and appropriate for a write-heavy append-only ledger.
- Indexed three ways for three questions: `(org_id, created_at)` for daily-spend queries, `workflow_id` for per-workflow attribution, `(provider, model_id, created_at)` for "how much did we spend on Sonnet last Tuesday?" analytics.
- **No UPDATE.** A refund is a negative-cost row. A correction is a new row with a note in `payload`. Auditable by construction.

## `orchestrator_service.budget_policies`

`UNIQUE (org_id, scope, period)` — at most one policy per org × scope × period. New policy → INSERT with `ON CONFLICT (…) DO UPDATE`. Guards read this table on every LLM call preflight — cached in Redis for 60s to avoid hammering it.

## `iam_service`

Deliberately minimal for the vertical slice. Real shape:

- `orgs` with a `daily_budget_usd` column — read by cost-budget guard
- `users` with `org_id` scope, bcrypted `password_hash`
- `api_keys` with `hash` (`sha256` of the clear key) + `scopes[]` — the api-gateway looks these up on every request

For dev, one seeded org (`00000000-0000-0000-0000-000000000001`) is created by `init.sql` so the platform boots into a usable state.

## Migration story

The vertical slice uses `deploy/postgres/init.sql` — run once, on first boot. That's fine for local dev, not fine for prod. The migration story we'd add:

- Per-service `migrations/` directory (`node-pg-migrate` or `Prisma migrate`)
- CI enforces "every DDL change ships as a numbered up + down"
- Application boot runs `migrate up` before serving — services fail to start on unapplied migrations
- Blue-green safe: each migration is either additive (drop is a follow-up commit after code is deployed) or backwards-compatible

## What's not modelled here

- **Multi-tenant row-level security** — every table has `org_id`, but Postgres RLS policies aren't installed. Adding them is one migration + a `SET LOCAL app.org_id = $1` in the connection pool per request. Out of scope for the slice.
- **Full-text search on EPD payloads** — planned as a GIN index on a `tsvector` column derived from selected `epd_data` fields (product name, manufacturer, description). Added when we add the query-service.
- **Event sourcing on extractions** — `extraction_events` is close, but we don't rebuild `extractions` state from events. Would be a good move if the shape of "extraction" gets more complex; today the JSONB `epd_data` is the canonical form and events are the log.

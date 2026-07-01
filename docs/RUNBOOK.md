# Runbook

How to run the platform locally, submit an extraction workflow end-to-end, and inspect what happened.

## 1. Prerequisites

- Docker (Desktop or Engine) — the whole stack runs in compose
- Node 20 for the e2e script (and for building services outside compose)
- `ANTHROPIC_API_KEY` — the extractor-agent calls the real Anthropic API via `llm-gateway`

## 2. First-time setup

```bash
cp .env.example .env
# Put your key into .env.local (gitignored) OR export it in your shell.
# Docker will pass it through to llm-gateway via env_file.
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local

npm install                    # installs all workspaces
npm run build --workspace @lcm/base-framework
```

## 3. Bring the stack online

```bash
npm run stack:up               # docker compose up --build
```

After ~30s you'll have:

| Service | URL | Notes |
| --- | --- | --- |
| RabbitMQ mgmt UI | http://localhost:15675 | guest/guest — watch queue depths |
| Postgres | `postgres://lcm:lcm@localhost:5442/lcm` | 4 schemas: document_service, materials_service, orchestrator_service, iam_service |
| MinIO console | http://localhost:9003 | lcm / lcm-minio-secret |
| Redis | `redis://localhost:6382` | rate-limit buckets live here |
| api-gateway | http://localhost:3010 | Swagger at `/api/docs` when the service is built |

Check every service is up:

```bash
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f orchestrator-service llm-gateway agent-workers
```

## 4. Submit an extraction workflow

The api-gateway route (`POST /documents/:id/extract`) is designed but not yet built (see ARCHITECTURE.md §6). For the vertical slice, submit directly to the orchestrator via the e2e script:

```bash
# Provide a real concrete EPD PDF. If you cloned lcm-hub (v1), you have 20 in /public/sources/.
npx tsx scripts/e2e/submit.ts ~/Downloads/epds/EPD_HUB-5210_2026-06-27_en.pdf
```

You'll see the workflow progress step by step:

```
→ submitting document 099ca7da (1.55 MB)
✓ workflow=e0f2… submitted in 24ms
[000s] wf=running $0.0000   triage[0]=pending extract[0]=pending verify[0]=pending verify[1]=pending verify[2]=pending persist[0]=pending
[001s] wf=running $0.0000   triage[0]=running  extract[0]=pending  ...
[043s] wf=running $0.3421   triage[0]=completed extract[0]=running verify[0]=pending  ...
[121s] wf=completed $0.4103  triage[0]=completed extract[0]=completed verify[0]=completed  ...
```

## 5. Inspect the run

Every workflow leaves a full trail across three Postgres tables:

```sql
-- The workflow itself + total cost
SELECT id, kind, status, cost_usd, created_at, completed_at
  FROM orchestrator_service.workflows
  ORDER BY created_at DESC LIMIT 5;

-- Every step + retries + per-step cost
SELECT step_name, fan_index, agent, status, attempts, cost_usd, failure_reason
  FROM orchestrator_service.workflow_steps
  WHERE workflow_id = 'e0f2...'
  ORDER BY step_name, fan_index;

-- Every LLM call (input/output tokens, USD, provider, model)
SELECT created_at, provider, model_id, input_tokens, output_tokens, cost_usd
  FROM orchestrator_service.cost_ledger
  WHERE workflow_id = 'e0f2...'
  ORDER BY created_at;
```

## 6. What to expect from the vertical slice

**What actually runs**: `orchestrator-service` + `llm-gateway` (Anthropic backend) + `agent-workers` (extractor-agent). The DAG engine dispatches steps, the extractor calls Anthropic, results flow back, cost is written to the ledger.

**What doesn't yet run**: `document-service` (uploads), `materials-service` (extraction persistence), `api-gateway` (HTTP entry), `triage-agent`, `verifier-agent`. Their contracts are in `packages/base-framework/src/contracts` and the workflow definition (`services/orchestrator-service/src/workflow/definitions.ts`) declares them — dispatching to those queues will succeed but no consumer is listening, so their steps stay `pending` in the DB.

**Reading the DB after a run** is the honest way to see what's built vs what's designed: `triage[0]=pending` in the step summary means "the DAG engine dispatched to `agents.triage-agent`, no consumer picked it up yet, and that's by design in this repo."

## 7. Common ops

| Task | Command |
| --- | --- |
| Watch RabbitMQ queue depths | http://localhost:15675 → Queues tab |
| Tail a service's logs | `docker compose -f deploy/docker-compose.yml logs -f <service>` |
| psql into a schema | `docker exec -it lcm-postgres psql -U lcm -d lcm` then `SET search_path TO orchestrator_service;` |
| Clear all workflows | `psql -c 'TRUNCATE orchestrator_service.workflows CASCADE;'` |
| Nuke everything (volumes too) | `npm run stack:down` (aliases `docker compose down -v`) |

## 8. Troubleshooting

- **`ANTHROPIC_API_KEY not set`** — the extractor-agent throws at first call. Put it in `.env.local`, restart the `llm-gateway` container.
- **Extractor step stays `running` forever** — check `docker compose logs llm-gateway`. Provider errors surface there with the request id.
- **Cost budget rejects everything** — the `cost-budget` guard is enforced against `GUARD_DAILY_ORG_LIMIT_USD` (default $25). Set higher in `.env` or `UPDATE iam_service.orgs SET daily_budget_usd = 100 WHERE id = '00000000-0000-0000-0000-000000000001'`.
- **Postgres migration errors on rebuild** — `npm run stack:down` (dropping the volume) then `stack:up`. The init.sql only runs on a fresh volume.

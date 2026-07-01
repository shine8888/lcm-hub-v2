# LCM Hub v2 — Platform

> The "how I would actually build this" repo. Companion to
> [`lcm-hub`](https://github.com/shine8888/lcm-hub) — the 4-hour, Vercel-deployed submission for the
> Low Carbon Materials Hub take-home. This repo is what the same product looks like when the
> constraint is "engineer this properly," not "ship it in an afternoon."

**Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first.** The design is the artifact.

---

## What's different from v1

| | v1 (submitted) | v2 (this repo) |
| --- | --- | --- |
| Extraction | One Node script → Anthropic direct → JSON file | **Multi-agent workflow** (triage → extract → verifier×3) via an **orchestrator** with retries, versioning, and audit |
| LLM calls | `@anthropic-ai/sdk` in the extraction script | **`llm-gateway` service** — LiteLLM-shaped provider abstraction, cost accounting per token, budget guardrails |
| Data layer | 20 static JSONs in `/data/` | Postgres per service, content-addressable idempotency, live/staged extraction versions, append-only audit log |
| Guardrails | Zod validation on write; snippet verifier script | Middleware chain around every LLM call: rate-limit → cost-budget → prompt-schema → content-policy → grounding → audit |
| Failure model | One-off run, `--force` to retry | RabbitMQ + DLQ + processing-lock + workflow-step retries |
| API surface | Static Next.js | NestJS REST gateway, Swagger, JWT auth |
| Delivery | Vercel `npx vercel --prod` | `docker compose up` — full stack, one command |

The one thing that **doesn't** change: the honesty contract from v1 (`declared:false` discriminated union, per-field provenance, functional-unit mismatch surfaced) is upheld by design here too. Everything v2 adds is scaffolding to keep that contract intact at scale.

---

## Repo layout

```
lcm-hub-v2/
├── packages/
│   ├── base-framework/       # shared TS lib: Zod contracts, LLMGateway
│   │                          # interface, RMQ patterns, EntityBase, filters
│   └── base-worker/           # shared queue-consumer scaffold for agents
├── services/
│   ├── api-gateway/           # NestJS · REST · JWT · Swagger · Idempotency-Key
│   ├── document-service/      # sha256 idempotency · MinIO storage · metadata
│   ├── orchestrator-service/  # DAG engine · guardrails · cost ledger · audit
│   ├── llm-gateway/           # provider abstraction · cost accounting · caching
│   ├── materials-service/     # extraction persistence · versioning · provenance
│   └── agent-workers/         # triage / extractor / verifier agents
├── deploy/
│   ├── docker-compose.yml     # full stack: pg + rabbit + redis + minio + services
│   └── postgres/init.sql      # per-service schemas
├── scripts/e2e/               # end-to-end vertical-slice smoke test
└── docs/
    ├── ARCHITECTURE.md        # system design + mermaid + ADRs (start here)
    ├── DB.md                  # schema rationale, indexes, migration story
    ├── RUNBOOK.md             # ops: run locally, trigger workflow, debug
    └── SCALE.md               # the throughput/cost/reliability path from here
```

---

## Vertical slice — what actually works end-to-end

The scope of this repo (see `docs/ARCHITECTURE.md` §6 "Vertical slice") is the **extraction workflow**, real all the way through:

```
POST /documents/upload  →  document-service (sha256 idempotency, MinIO)
                       →  orchestrator submits Workflow(extraction)
                       →  triage-agent classifies + routes
                       →  extractor-agent calls llm-gateway → Anthropic
                       →  verifier-agent × 3 (parallel adversarial ground-check)
                       →  materials-service persists extraction + provenance
                       →  cost_ledger + extraction_events populated
```

Everything else — query-service, IAM properly, LiteLLM live provider fallback, human-review UI — is scaffolded with typed interfaces and TODOs pointing to the architecture doc. That's the "how would you extend this" you can walk through in an interview.

Run it: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

## Status

Actively under construction. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design; the code lands service by service.

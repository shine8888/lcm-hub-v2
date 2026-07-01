# Scale path

What breaks first, and what the fix looks like — in the order the pain arrives.

## ~100 PDFs/day (this shape)

Nothing breaks. Docker-compose runs everything on a laptop. Extraction latency is dominated by the LLM call (~45s median in v1 measurements). No autoscaling, no clustering, no read replicas.

## ~1k PDFs/day (first pinch)

**Where it hurts**: `llm-gateway` becomes the bottleneck if single-tenant on Anthropic. Rate limits start biting; cost climbs faster than throughput.

**The three fixes, in order of leverage:**

1. **Prompt caching.** The extraction system prompt is ~4k tokens and identical across every extraction. Turn on Anthropic's prompt caching → ~90% discount on the cached portion. 4×-6× cost reduction on the input side, no code change beyond a `cache_control` marker in the anthropic backend.
2. **Page targeting.** Introduce a cheap Haiku "which pages contain the LCA table?" step (the `triage-agent` is where it lives). Only those pages go to Sonnet. 5-10× input-token cut on long PDFs (Holcim's are 30+ pages; the table is 2).
3. **Model tiering.** Haiku for triage + metadata (cover page). Sonnet for the LCA table. Opus reserved for ambiguous cases the verifier flags. `LLM_ROUTE_*` env vars route without code change.

## ~10k PDFs/day (rate limits + concurrency)

**Where it hurts**: Anthropic rate limits (whether tokens-per-minute or requests-per-minute) start rejecting calls even with caching + tiering. `agent-workers` pods pile up in "running" waiting for API windows.

**Fixes:**

- **Provider fan-out at the gateway.** `llm-gateway.router` configured with multiple backends for the same *logical* model — `LLM_ROUTE_EXTRACTOR=claude-sonnet-4-6,gpt-4o`. Each provider has its own rate-limit bucket in Redis. First-available wins.
- **Multi-account.** Same provider, multiple API keys, round-robin at the gateway. Cheap horizontal scale before you pay for higher-tier limits.
- **BullMQ backpressure.** The extractor-agent's queue gets a concurrency cap tied to observed rate-limit responses. When 429s spike, we throttle the queue rather than let workers spin.

## ~100k PDFs/day (Postgres pinch)

**Where it hurts**: `cost_ledger` and `extraction_events` grow unbounded. Aggregation queries (daily spend, workflow-level cost) slow down. Vacuum churn on `workflow_steps`.

**Fixes:**

- **Partition `cost_ledger` and `extraction_events` by month.** Drop-old-partitions is a fast metadata op; VACUUM stops chasing a global tuple graveyard.
- **Move `cost_ledger` to ClickHouse (or Redshift).** Time-series aggregation is what OLAP columnstores are for. Row per LLM call is cheap in ClickHouse; the daily-spend query is a scan of one column.
- **Read replica for `materials-service`.** The materials CRUD is read-heavy (list, compare). The write-heavy `orchestrator_service` schema stays on the primary; the read replica serves the app.

## ~1M PDFs/day (control plane / data plane)

**Where it hurts**: orchestrator becomes a single point that has to know about every workflow. RabbitMQ single-node can't take the queue-depth.

**Fixes:**

- **Kubernetes with HPA on queue depth.** `agent-workers` deployments scale out horizontally based on `agents.extractor-agent` depth. Stateless agents = clean horizontal scale.
- **RabbitMQ clustering** (or migrate to NATS / SQS — the `messaging/patterns.ts` abstraction shields us from swap).
- **Orchestrator becomes a control plane, not a data plane.** Today, orchestrator dispatches every step. At this scale, agents pull from queues autonomously and only publish results — orchestrator becomes a state reconciler running periodically.
- **Introduce sharded workflows.** `workflow_id` prefix routes to different orchestrator shards, each with its own Postgres partition. `orchestrator-service` becomes N deployments, each responsible for `workflow_id LIKE 'a%'`, `'b%'`, etc.

## Cost story alongside throughput

Rough envelope on per-PDF cost at 100k/day, assuming the fixes above:
- Base A1-A3 extract on cached prompt + page-targeted pages: ~$0.02 per PDF (Sonnet)
- Verifier fan-out (3× Haiku): ~$0.005
- Triage: negligible
- Total: ~$0.025/PDF · 100k/day = **$2.5k/day** = ~$75k/month LLM spend

At $75k/month in LLM cost, the *engineering* cost of a good `cost_ledger` + budget guards + prompt caching pays for itself in < 1 week. That's why cost isn't a phase 3 optimization — it's an architectural axis, present in `cost_ledger` from day one.

## What we deliberately do NOT scale up

- **Multi-region.** Adds coordination cost with no throughput benefit for this workload. Single region until we have customers in a different jurisdiction who require data residency.
- **Custom-hosted LLMs.** llama-3-70B fine-tuned on EPDs is technically feasible; economically doesn't pay until Anthropic/OpenAI spend is >$100k/month AND the customer base tolerates in-house infra risk. Kept as a documented future.
- **Real-time collaborative editing.** Extraction is batch. Multi-user "review this extraction together" is a query-side feature; adding it doesn't require re-architecting extraction.

## The one thing that DOESN'T change across all scales

The honesty contract from v1: **declared:false ≠ zero, provenance required, functional-unit mismatch surfaces**. Every fix above adds infrastructure to keep that contract intact at higher throughput. If a scaling move would weaken the contract, we don't make it — we find a different fix.

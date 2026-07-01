import type { WorkflowDefinition } from '@lcm/base-framework';

/**
 * The extraction workflow is data.
 *
 * A prompt bump, model swap, or a new step name (e.g. adding a
 * "normalize-units-agent") is a diff on THIS OBJECT, not a change to the
 * DAG engine. The engine consumes this literally — steps are dispatched,
 * edges (implicit here — sequential + verifier fan-out) drive readiness.
 *
 * Persisted verbatim in `orchestrator_service.workflows.definition` so
 * we can replay historical workflows even after the code moves on.
 */
export const EXTRACT_EPD_WORKFLOW: WorkflowDefinition = {
  kind: 'extract-epd',
  steps: [
    {
      name: 'triage',
      agent: 'triage-agent',
      timeoutMs: 30_000,
      maxAttempts: 2,
      input: {},
    },
    {
      name: 'extract',
      agent: 'extractor-agent',
      timeoutMs: 180_000,
      maxAttempts: 3,
      input: {},
    },
    {
      name: 'verify',
      agent: 'verifier-agent',
      timeoutMs: 60_000,
      maxAttempts: 2,
      input: {},
      fanOut: { count: 3, seedKey: 'seed' }, // 3 parallel adversarial verifiers
    },
    {
      name: 'persist',
      agent: 'materials-service', // not a subagent — a domain service invoked via RPC
      timeoutMs: 15_000,
      maxAttempts: 3,
      input: {},
    },
  ],
  edges: [
    { from: 'triage', to: 'extract', requires: 'completed' },
    { from: 'extract', to: 'verify', requires: 'completed' },
    { from: 'verify', to: 'persist', requires: 'completed' },
  ],
};

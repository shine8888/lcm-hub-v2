/**
 * Workflow contracts. A Workflow is a DAG of Steps. The orchestrator owns
 * the state machine; agents own the leaf work.
 *
 * Design note: the DAG is *data*, defined once per workflow kind and
 * persisted alongside the workflow row. Swapping a step (e.g. replacing
 * `verifier-v1` with `verifier-v2`) is a config change, not a code change.
 */
import { z } from 'zod';

export const workflowKind = z.enum(['extract-epd', 'query-materials']);
export type WorkflowKind = z.infer<typeof workflowKind>;

export const workflowStatus = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'paused_budget',
  'needs_review',
]);
export type WorkflowStatus = z.infer<typeof workflowStatus>;

export const stepStatus = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof stepStatus>;

export const stepFailureReason = z.enum([
  'rate_limited',
  'budget_exceeded',
  'content_policy_violation',
  'schema_validation_failed',
  'grounding_failed',
  'provider_error',
  'timeout',
  'unknown',
]);
export type StepFailureReason = z.infer<typeof stepFailureReason>;

/** DAG edge — target step depends on all sources having a specified status. */
export const stepEdge = z.object({
  from: z.string(), // step name
  to: z.string(),
  /** default: 'completed' */
  requires: stepStatus.default('completed'),
});

/** Fan-out spec — replicate a step N times with an index seed. */
export const fanOut = z.object({
  count: z.number().int().positive(),
  seedKey: z.string().default('fanIndex'),
});

export const stepDefinition = z.object({
  name: z.string(),
  agent: z.string(), // 'triage-agent', 'extractor-agent', 'verifier-agent', ...
  input: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().positive().default(120_000),
  maxAttempts: z.number().int().positive().default(3),
  fanOut: fanOut.optional(),
});
export type StepDefinition = z.infer<typeof stepDefinition>;

export const workflowDefinition = z.object({
  kind: workflowKind,
  steps: z.array(stepDefinition).min(1),
  edges: z.array(stepEdge).default([]),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinition>;

/** Consumed by the orchestrator to hydrate + dispatch a step. */
export const stepDispatchMessage = z.object({
  workflowId: z.string().uuid(),
  stepId: z.string().uuid(),
  agent: z.string(),
  input: z.record(z.string(), z.unknown()),
  attempt: z.number().int().positive(),
});
export type StepDispatchMessage = z.infer<typeof stepDispatchMessage>;

/** Emitted by an agent when a step completes (or throws). */
export const stepResultMessage = z.object({
  workflowId: z.string().uuid(),
  stepId: z.string().uuid(),
  status: stepStatus,
  output: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({
      reason: stepFailureReason,
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    })
    .optional(),
});
export type StepResultMessage = z.infer<typeof stepResultMessage>;

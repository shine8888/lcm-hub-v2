import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';

import type {
  StepDefinition,
  StepFailureReason,
  StepStatus,
  WorkflowDefinition,
  WorkflowKind,
  WorkflowStatus,
} from '@lcm/base-framework';

import { PG_POOL } from './pg';

/**
 * Repository over orchestrator_service.workflows + workflow_steps.
 *
 * Raw SQL on purpose: the load-bearing invariants (uniqueness, transactional
 * step transitions, single-writer locks) are more legible as SQL than as
 * ORM-migrated abstractions. Every method that mutates >1 row uses a
 * transaction; every state transition is atomic.
 */
@Injectable()
export class WorkflowRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async createWorkflow(input: {
    orgId: string;
    kind: WorkflowKind;
    inputRef: string;
    definition: WorkflowDefinition;
    deadlineAt?: Date;
  }): Promise<{ workflowId: string; steps: PersistedStep[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const wfRes = await client.query<{ id: string }>(
        `INSERT INTO orchestrator_service.workflows (org_id, kind, input_ref, status, definition, deadline_at)
         VALUES ($1, $2, $3, 'pending', $4::jsonb, $5)
         RETURNING id`,
        [input.orgId, input.kind, input.inputRef, JSON.stringify(input.definition), input.deadlineAt ?? null],
      );
      const workflowId = wfRes.rows[0].id;

      // Materialize steps up-front — fan-out replicates the step N times.
      const steps: PersistedStep[] = [];
      for (const def of input.definition.steps) {
        const count = def.fanOut?.count ?? 1;
        for (let i = 0; i < count; i++) {
          const stepId = randomUUID();
          const input = def.fanOut ? { ...def.input, [def.fanOut.seedKey]: i } : def.input;
          await client.query(
            `INSERT INTO orchestrator_service.workflow_steps
               (id, workflow_id, step_name, agent, fan_index, input, status)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending')`,
            [stepId, workflowId, def.name, def.agent, i, JSON.stringify(input)],
          );
          steps.push({
            id: stepId,
            workflowId,
            stepName: def.name,
            agent: def.agent,
            fanIndex: i,
            input,
            status: 'pending',
            attempts: 0,
          });
        }
      }
      await client.query('COMMIT');
      return { workflowId, steps };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async setWorkflowStatus(workflowId: string, status: WorkflowStatus): Promise<void> {
    await this.pool.query(
      `UPDATE orchestrator_service.workflows
         SET status = $2::orchestrator_service.workflow_status,
             completed_at = CASE WHEN $2 IN ('completed','failed') THEN NOW() ELSE completed_at END,
             updated_at = NOW()
       WHERE id = $1`,
      [workflowId, status],
    );
  }

  async listPendingSteps(workflowId: string): Promise<PersistedStep[]> {
    const res = await this.pool.query(
      `SELECT id, workflow_id, step_name, agent, fan_index, input, status, attempts
         FROM orchestrator_service.workflow_steps
        WHERE workflow_id = $1
        ORDER BY step_name, fan_index`,
      [workflowId],
    );
    return res.rows.map(rowToStep);
  }

  async claimStep(stepId: string): Promise<PersistedStep | null> {
    // Atomically pending → running with attempts++.
    // If the row is already running/completed, returns null.
    const res = await this.pool.query(
      `UPDATE orchestrator_service.workflow_steps
          SET status = 'running',
              attempts = attempts + 1,
              started_at = COALESCE(started_at, NOW())
        WHERE id = $1 AND status = 'pending'
        RETURNING id, workflow_id, step_name, agent, fan_index, input, status, attempts`,
      [stepId],
    );
    return res.rowCount ? rowToStep(res.rows[0]) : null;
  }

  async completeStep(
    stepId: string,
    status: Extract<StepStatus, 'completed' | 'failed' | 'skipped'>,
    payload: {
      output?: Record<string, unknown>;
      failureReason?: StepFailureReason;
      costUsd?: number;
    },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE orchestrator_service.workflow_steps
          SET status = $2::orchestrator_service.step_status,
              output = $3::jsonb,
              failure_reason = $4,
              cost_usd = COALESCE(cost_usd, 0) + COALESCE($5, 0),
              completed_at = NOW()
        WHERE id = $1`,
      [
        stepId,
        status,
        payload.output ? JSON.stringify(payload.output) : null,
        payload.failureReason ?? null,
        payload.costUsd ?? 0,
      ],
    );
  }

  async writeCostLedger(entry: {
    orgId: string;
    workflowId: string;
    stepId?: string;
    provider: string;
    modelId: string;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    costUsd: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO orchestrator_service.cost_ledger
         (org_id, workflow_id, step_id, provider, model_id,
          input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.orgId,
        entry.workflowId,
        entry.stepId ?? null,
        entry.provider,
        entry.modelId,
        entry.inputTokens,
        entry.cacheReadTokens,
        entry.cacheWriteTokens,
        entry.outputTokens,
        entry.costUsd,
      ],
    );
    await this.pool.query(
      `UPDATE orchestrator_service.workflows
          SET cost_usd = cost_usd + $2
        WHERE id = $1`,
      [entry.workflowId, entry.costUsd],
    );
  }

  async orgDailySpendUsd(orgId: string, client?: PoolClient): Promise<number> {
    const runner = client ?? this.pool;
    const res = await runner.query<{ sum: string }>(
      `SELECT COALESCE(SUM(cost_usd), 0)::text AS sum
         FROM orchestrator_service.cost_ledger
        WHERE org_id = $1 AND created_at > date_trunc('day', NOW())`,
      [orgId],
    );
    return Number(res.rows[0].sum);
  }
}

export interface PersistedStep {
  id: string;
  workflowId: string;
  stepName: string;
  agent: string;
  fanIndex: number;
  input: Record<string, unknown>;
  status: StepStatus;
  attempts: number;
}

interface StepRow {
  id: string;
  workflow_id: string;
  step_name: string;
  agent: string;
  fan_index: number;
  input: unknown;
  status: StepStatus;
  attempts: number;
}

function rowToStep(r: StepRow): PersistedStep {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    stepName: r.step_name,
    agent: r.agent,
    fanIndex: r.fan_index,
    input: (r.input ?? {}) as Record<string, unknown>,
  status: r.status,
    attempts: r.attempts,
  };
}

// Re-export the definition types nothing else needs but this file:
export type { StepDefinition };

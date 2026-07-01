import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import type { Guard, GuardVerdict, LLMRequest, LLMResponse } from '@lcm/base-framework';

import { PG_POOL } from '../db/pg';

/**
 * Records every LLM interaction to `extraction_events` (materials
 * schema — cross-schema write). Append-only, single-row per call, so
 * the audit table is the log of every AI touch on every document.
 *
 * This is the LAST guard in the chain — everything else has ruled on
 * accept/reject; we just record what happened.
 */
@Injectable()
export class AuditEmitGuard implements Guard<LLMRequest, LLMResponse> {
  readonly name = 'audit-emit';

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async postflight(input: LLMRequest, output: LLMResponse): Promise<GuardVerdict<LLMResponse>> {
    // Extraction id is optional here; the workflow-step id + workflow-id
    // are enough to reconstruct lineage.
    await this.pool.query(
      `INSERT INTO materials_service.extraction_events
         (extraction_id, event_type, payload, actor)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), 'llm.called', $2::jsonb, 'orchestrator')`,
      [
        null, // filled in later by materials-service when extraction row is created
        JSON.stringify({
          workflowId: input.workflowId,
          stepId: input.stepId,
          provider: output.provider,
          model: input.model,
          usage: output.usage,
          costUsd: output.costUsd,
          promptVersion: input.promptVersion,
          requestId: output.requestId,
        }),
      ],
    );
    return { ok: true, value: output };
  }
}

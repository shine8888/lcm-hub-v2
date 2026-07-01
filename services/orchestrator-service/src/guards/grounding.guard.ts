import { Injectable, Logger } from '@nestjs/common';

import type { Guard, GuardVerdict, LLMRequest, LLMResponse } from '@lcm/base-framework';

/**
 * Post-flight grounding check.
 *
 * This is a *placeholder* that acknowledges the design: in production,
 * every provenance snippet in the extraction's output would be
 * substring-matched against the source PDF's text layer (or, in the
 * v2-of-v2 evolution, cross-checked by a second vision model).
 *
 * Left as a stub for the vertical slice because it needs the extraction
 * output shape stabilized — see `scripts/verify/run.ts` in the v1 repo
 * for the actual grounding logic, which slots in here.
 */
@Injectable()
export class GroundingGuard implements Guard<LLMRequest, LLMResponse> {
  readonly name = 'grounding';
  private readonly log = new Logger(GroundingGuard.name);

  async postflight(_input: LLMRequest, output: LLMResponse): Promise<GuardVerdict<LLMResponse>> {
    // In the vertical slice we don't have the PDF text layer here.
    // The grounding pass is the verifier-agent's job (see
    // `services/agent-workers/src/verifier`) — this guard is where a
    // *cross-cutting* ground check would live, applied to every LLM
    // call regardless of agent.
    this.log.debug('grounding guard is a stub in this slice (see ARCHITECTURE.md §5).');
    return { ok: true, value: output };
  }
}

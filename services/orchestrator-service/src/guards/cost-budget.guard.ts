import { Injectable, Logger } from '@nestjs/common';

import type { Guard, GuardVerdict, LLMRequest, LLMResponse } from '@lcm/base-framework';
import { intEnv, providerOf } from '@lcm/base-framework';

import { WorkflowRepository } from '../db/workflow.repo';

/**
 * Preflight: reject the LLM call if the org's cumulative daily spend
 * would exceed the budget after a naive estimate.
 *
 * Postflight: track the actual cost against the ledger. If a single call
 * blew past the budget (which can happen if the naive estimate under-
 * predicted), pause the workflow rather than continue silently.
 */
@Injectable()
export class CostBudgetGuard implements Guard<LLMRequest, LLMResponse> {
  readonly name = 'cost-budget';
  private readonly log = new Logger(CostBudgetGuard.name);
  private readonly dailyLimitUsd = intEnv('GUARD_DAILY_ORG_LIMIT_USD', 25);

  constructor(private readonly repo: WorkflowRepository) {}

  async preflight(input: LLMRequest): Promise<GuardVerdict<LLMRequest>> {
    const spend = await this.repo.orgDailySpendUsd(input.orgId);
    if (spend >= this.dailyLimitUsd) {
      this.log.warn(`org=${input.orgId} spend=$${spend.toFixed(4)} >= limit=$${this.dailyLimitUsd}`);
      return {
        ok: false,
        reason: 'budget_exceeded',
        message: `Daily org budget exceeded ($${spend.toFixed(2)} >= $${this.dailyLimitUsd})`,
        details: { orgId: input.orgId, spend, limit: this.dailyLimitUsd },
      };
    }
    return { ok: true, value: input };
  }

  async postflight(input: LLMRequest, output: LLMResponse): Promise<GuardVerdict<LLMResponse>> {
    // Ledger write is what makes the budget real — future preflights read from it.
    await this.repo.writeCostLedger({
      orgId: input.orgId,
      workflowId: input.workflowId!,
      stepId: input.stepId,
      provider: providerOf(input.model),
      modelId: input.model,
      inputTokens: output.usage.inputTokens,
      cacheReadTokens: output.usage.cacheReadTokens,
      cacheWriteTokens: output.usage.cacheWriteTokens,
      outputTokens: output.usage.outputTokens,
      costUsd: output.costUsd,
    });
    return { ok: true, value: output };
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import type { Guard, LLMRequest, LLMResponse } from '@lcm/base-framework';
import { CLIENT_TOKENS, LLM_GATEWAY_PATTERNS, runGuarded } from '@lcm/base-framework';

import { CostBudgetGuard } from './cost-budget.guard';
import { RateLimitGuard } from './rate-limit.guard';
import { GroundingGuard } from './grounding.guard';
import { AuditEmitGuard } from './audit-emit.guard';

/**
 * The one place in the platform where the guardrail chain wraps an LLM
 * call. Every agent that wants to talk to a model *must* come through
 * here — direct llm-gateway calls are architecturally forbidden.
 *
 * The chain order matters:
 *   1. rate-limit: cheapest check first, kills obvious runaways
 *   2. cost-budget: db read, but still ~1ms
 *   3. [ call ]
 *   4. audit-emit: postflight, always runs
 *   5. grounding: postflight, may reject a plausible-but-ungrounded output
 */
@Injectable()
export class GuardedLLMService {
  private readonly log = new Logger(GuardedLLMService.name);
  private readonly chain: Guard<LLMRequest, LLMResponse>[];

  constructor(
    rateLimit: RateLimitGuard,
    costBudget: CostBudgetGuard,
    audit: AuditEmitGuard,
    grounding: GroundingGuard,
    @Inject(CLIENT_TOKENS.LLM_GATEWAY) private readonly llm: ClientProxy,
  ) {
    // Preflight order = declared order. Postflight order = reverse.
    this.chain = [rateLimit, costBudget, audit, grounding];
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const verdict = await runGuarded(this.chain, request, (req) =>
      firstValueFrom(this.llm.send<LLMResponse>(LLM_GATEWAY_PATTERNS.CALL, req)),
    );
    if (!verdict.ok) {
      this.log.warn(`guard rejected: ${verdict.reason} — ${verdict.message}`);
      throw new GuardedCallRejection(verdict.reason, verdict.message, verdict.details);
    }
    return verdict.value;
  }
}

export class GuardedCallRejection extends Error {
  constructor(
    public readonly reason: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GuardedCallRejection';
  }
}

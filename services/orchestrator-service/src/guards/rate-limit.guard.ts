import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

import type { Guard, GuardVerdict, LLMRequest, LLMResponse } from '@lcm/base-framework';
import { intEnv, requireEnv } from '@lcm/base-framework';

/**
 * Fixed-window rate limit per (org, provider, model), enforced in Redis
 * so multiple orchestrator instances share a single limit.
 *
 * Simpler than a leaky/token bucket but sufficient for this workload —
 * we're not doing per-request pacing, we're stopping runaway loops from
 * exhausting our provider quota.
 */
@Injectable()
export class RateLimitGuard implements Guard<LLMRequest, LLMResponse> {
  readonly name = 'rate-limit';
  private readonly log = new Logger(RateLimitGuard.name);
  private readonly redis = new Redis(requireEnv('REDIS_URL'));
  private readonly rpm = intEnv('GUARD_RATE_LIMIT_RPM', 60);

  async preflight(input: LLMRequest): Promise<GuardVerdict<LLMRequest>> {
    // 60-second bucket keyed by minute.
    const bucket = Math.floor(Date.now() / 60_000);
    const key = `rl:${input.orgId}:${input.model}:${bucket}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 65);
    if (n > this.rpm) {
      this.log.warn(`rate limit exceeded org=${input.orgId} model=${input.model} n=${n} rpm=${this.rpm}`);
      return {
        ok: false,
        reason: 'rate_limited',
        message: `Rate limit exceeded (${n} > ${this.rpm} per minute for ${input.model})`,
        details: { model: input.model, n, rpm: this.rpm },
      };
    }
    return { ok: true, value: input };
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}

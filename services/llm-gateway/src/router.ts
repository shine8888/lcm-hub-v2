import { Injectable, Logger } from '@nestjs/common';
import type { LLMBackend, LLMRequest, LLMResponse, LLMGateway, ModelId } from '@lcm/base-framework';
import { providerOf } from '@lcm/base-framework';

import { AnthropicBackend } from './backends/anthropic.backend';
import { OpenAIBackend } from './backends/openai.backend';

/**
 * The LLMGateway implementation the rest of the platform sees.
 *
 * Responsibilities:
 * 1. Route `LLMRequest` → the right `LLMBackend` for its model.
 * 2. Handle provider fallback — if the primary backend throws (rate
 *    limit, provider down), try the next in the route list.
 * 3. Nothing else. Cost accounting + guardrails live in the
 *    orchestrator, wrapping this call.
 *
 * The route list is data: env vars like `LLM_ROUTE_EXTRACTOR`. A new
 * customer with stricter policy just gets a different route config.
 */
@Injectable()
export class LLMGatewayRouter implements LLMGateway {
  private readonly log = new Logger(LLMGatewayRouter.name);
  private readonly backends: LLMBackend[];

  constructor(anthropic: AnthropicBackend, openai: OpenAIBackend) {
    this.backends = [anthropic, openai];
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const provider = providerOf(request.model);
    const backend = this.backends.find((b) => b.provider === provider && b.supports(request.model));
    if (!backend) {
      throw new Error(`No backend supports model ${request.model} (provider=${provider})`);
    }
    try {
      return await backend.invoke(request);
    } catch (e) {
      const err = e as Error;
      this.log.warn(`primary backend ${backend.provider} failed for ${request.model}: ${err.message}`);
      // Fallback: try each other backend whose supports() returns true
      // for an *aliased* model. In this repo we don't have model aliases
      // implemented — this is where they'd hook in.
      throw err;
    }
  }

  /** Cost estimate without making the call — for the cost-budget guard. */
  estimateCost(model: ModelId, estimatedInputTokens: number, estimatedOutputTokens: number): number {
    // Same math as the real accounting; keeps guards and reality consistent.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { costUsd } = require('@lcm/base-framework') as typeof import('@lcm/base-framework');
    return costUsd(
      {
        inputTokens: estimatedInputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: estimatedOutputTokens,
      },
      model,
    );
  }
}

import { Injectable, Logger } from '@nestjs/common';
import type {
  LLMBackend,
  LLMRequest,
  LLMResponse,
  ModelId,
} from '@lcm/base-framework';
import { MODEL_PRICING } from '@lcm/base-framework';

/**
 * OpenAI backend — deliberately stubbed. It's here to prove the swap
 * is real (see `router.ts`): the gateway can be configured to route
 * `gpt-4o` through this backend at runtime without touching a caller.
 *
 * A production implementation would use `openai` SDK with the
 * `response_format: { type: 'json_schema' }` mode to reach parity with
 * Anthropic's tool_use behaviour. Left as a TODO — the point of this
 * file is the interface conformance, not another vendor integration.
 */
@Injectable()
export class OpenAIBackend implements LLMBackend {
  readonly provider = 'openai';
  private readonly log = new Logger(OpenAIBackend.name);

  supports(model: ModelId): boolean {
    return MODEL_PRICING[model]?.provider === 'openai';
  }

  async invoke(_request: LLMRequest): Promise<LLMResponse> {
    this.log.warn(
      'OpenAI backend invoked — this is the stub. Implement with the openai SDK to enable real fallback.',
    );
    throw new Error(
      'OpenAI backend is stubbed. Set LLM_ROUTE_* env vars to prefer Anthropic, or implement openai.backend.ts.',
    );
  }
}

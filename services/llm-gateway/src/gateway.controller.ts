import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';

import type { LLMRequest, LLMResponse } from '@lcm/base-framework';
import { LLM_GATEWAY_PATTERNS, llmRequest } from '@lcm/base-framework';

import { LLMGatewayRouter } from './router';

/**
 * The over-the-wire face of the gateway. Every call from the orchestrator
 * or an agent lands here via RabbitMQ. Zod validates the payload — if a
 * caller sends garbage, we reject at the door.
 */
@Controller()
export class GatewayController {
  private readonly log = new Logger(GatewayController.name);

  constructor(private readonly router: LLMGatewayRouter) {}

  @MessagePattern(LLM_GATEWAY_PATTERNS.CALL)
  async call(@Payload() payload: unknown): Promise<LLMResponse> {
    const parsed = llmRequest.safeParse(payload);
    if (!parsed.success) {
      throw new RpcException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'invalid_llm_request',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const req: LLMRequest = parsed.data;
    try {
      return await this.router.call(req);
    } catch (e) {
      const err = e as Error;
      this.log.error(`gateway.call ${req.model} failed: ${err.message}`);
      throw new RpcException({
        statusCode: 502,
        error: 'Bad Gateway',
        code: 'provider_error',
        message: err.message,
      });
    }
  }
}

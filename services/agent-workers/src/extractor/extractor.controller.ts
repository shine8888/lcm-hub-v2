import { Controller, Inject, Logger } from '@nestjs/common';
import { ClientProxy, EventPattern, Payload } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { z } from 'zod';

import type { LLMRequest, LLMResponse, StepResultMessage } from '@lcm/base-framework';
import {
  AGENT_STEP_RESULT,
  CLIENT_TOKENS,
  LLM_GATEWAY_PATTERNS,
  stepDispatchMessage,
  epdPayload,
  agentQueue,
} from '@lcm/base-framework';

import { EXTRACTION_PROMPT_VERSION, EXTRACTION_SYSTEM_PROMPT, EXTRACTION_TOOL_INPUT_SCHEMA } from './prompt';

/**
 * The extractor-agent. Consumes step dispatches for `extractor-agent`,
 * calls llm-gateway with the extraction prompt + tool_use, validates
 * the returned payload against the shared Zod contract, and emits the
 * result back to the orchestrator.
 *
 * This agent is intentionally *stupid*. It does one thing: turn a PDF
 * into a validated EpdPayload. It does not know about workflows, DAGs,
 * cost, or persistence. That separation is the point.
 */
const extractorInput = z.object({
  documentId: z.string().uuid(),
  documentBase64: z.string().min(1),
});

@Controller()
export class ExtractorController {
  private readonly log = new Logger(ExtractorController.name);

  constructor(
    @Inject(CLIENT_TOKENS.LLM_GATEWAY) private readonly llm: ClientProxy,
    @Inject(CLIENT_TOKENS.ORCHESTRATOR_SERVICE) private readonly orch: ClientProxy,
  ) {}

  @EventPattern(agentQueue('extractor-agent'))
  async onDispatch(@Payload() payload: unknown): Promise<void> {
    const parsed = stepDispatchMessage.safeParse(payload);
    if (!parsed.success) {
      this.log.error(`invalid dispatch: ${JSON.stringify(parsed.error.issues)}`);
      return;
    }
    const msg = parsed.data;
    const inp = extractorInput.safeParse(msg.input);
    if (!inp.success) {
      await this.emitResult({
        workflowId: msg.workflowId,
        stepId: msg.stepId,
        status: 'failed',
        error: {
          reason: 'schema_validation_failed',
          message: `extractor input invalid: ${JSON.stringify(inp.error.issues)}`,
        },
      });
      return;
    }

    this.log.log(`extract doc=${inp.data.documentId.slice(0, 8)} step=${msg.stepId.slice(0, 8)}`);

    const request: LLMRequest = {
      model: process.env.LLM_ROUTE_EXTRACTOR?.split(',')[0] ?? 'claude-sonnet-4-6',
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              mediaType: 'application/pdf',
              data: inp.data.documentBase64,
            },
            {
              type: 'text',
              text: `Extract from the attached EPD PDF. Use tool submit_epd. Document id: ${inp.data.documentId}`,
            },
          ],
        },
      ],
      maxTokens: 16_000,
      temperature: 0,
      tool: {
        name: 'submit_epd',
        description: 'Submit the extracted EPD record. Input must match the schema in the system prompt.',
        inputSchema: EXTRACTION_TOOL_INPUT_SCHEMA,
      },
      promptVersion: EXTRACTION_PROMPT_VERSION,
      workflowId: msg.workflowId,
      stepId: msg.stepId,
      orgId: '00000000-0000-0000-0000-000000000001', // dev org
    };

    let response: LLMResponse;
    try {
      response = await firstValueFrom(this.llm.send<LLMResponse>(LLM_GATEWAY_PATTERNS.CALL, request));
    } catch (e) {
      const err = e as Error;
      await this.emitResult({
        workflowId: msg.workflowId,
        stepId: msg.stepId,
        status: 'failed',
        error: { reason: 'provider_error', message: err.message },
      });
      return;
    }

    // Validate against the shared Zod contract. If the model produced
    // garbage, this is where we catch it — failing the step lets the
    // orchestrator's retry policy re-dispatch (up to maxAttempts).
    const payloadParse = epdPayload.safeParse(response.toolInput);
    if (!payloadParse.success) {
      await this.emitResult({
        workflowId: msg.workflowId,
        stepId: msg.stepId,
        status: 'failed',
        error: {
          reason: 'schema_validation_failed',
          message: `EpdPayload validation failed`,
          details: {
            issues: payloadParse.error.issues.slice(0, 8).map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        },
        usage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          costUsd: response.costUsd,
        },
      });
      return;
    }

    await this.emitResult({
      workflowId: msg.workflowId,
      stepId: msg.stepId,
      status: 'completed',
      output: {
        payload: payloadParse.data,
        model: response.model,
        promptVersion: EXTRACTION_PROMPT_VERSION,
      },
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        costUsd: response.costUsd,
      },
    });
  }

  private async emitResult(result: StepResultMessage): Promise<void> {
    this.orch.emit(AGENT_STEP_RESULT, result);
  }
}

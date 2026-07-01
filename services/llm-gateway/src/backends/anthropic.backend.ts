import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import type {
  LLMBackend,
  LLMRequest,
  LLMResponse,
  ModelId,
} from '@lcm/base-framework';
import { costUsd, MODEL_PRICING, providerOf } from '@lcm/base-framework';

/**
 * Anthropic backend. This is the real one — it makes actual API calls.
 * Every provider-specific quirk (PDF content blocks, tool_use forcing,
 * cache control) lives here and NOWHERE else. Callers see the
 * provider-agnostic `LLMBackend` interface.
 */
@Injectable()
export class AnthropicBackend implements LLMBackend {
  readonly provider = 'anthropic';
  private readonly log = new Logger(AnthropicBackend.name);
  private readonly client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  supports(model: ModelId): boolean {
    return MODEL_PRICING[model]?.provider === 'anthropic';
  }

  async invoke(request: LLMRequest): Promise<LLMResponse> {
    if (providerOf(request.model) !== 'anthropic') {
      throw new Error(`AnthropicBackend cannot serve model ${request.model}`);
    }

    // Map generic messages → Anthropic message blocks
    const messages: Anthropic.MessageParam[] = request.messages.map((m) => {
      if (typeof m.content === 'string') {
        return { role: m.role === 'system' ? 'user' : m.role, content: m.content };
      }
      const blocks = m.content.map((b): Anthropic.ContentBlockParam => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        return {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: b.data },
        };
      });
      return { role: m.role === 'system' ? 'user' : m.role, content: blocks };
    });

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      messages,
    };
    if (request.system) params.system = request.system;

    // Forced structured output via tool_use — same technique as v1.
    // A caller that wants a strict JSON output sets `request.tool`; the
    // backend wires it up and the caller reads `response.toolInput`.
    if (request.tool) {
      params.tools = [
        {
          name: request.tool.name,
          description: request.tool.description,
          input_schema: {
            type: 'object',
            ...(request.tool.inputSchema as Record<string, unknown>),
          } as Anthropic.Tool.InputSchema,
        },
      ];
      params.tool_choice = { type: 'tool', name: request.tool.name };
    }

    const started = Date.now();
    const msg = await this.client.messages.create(params);
    const elapsed = Date.now() - started;

    const usage = {
      inputTokens: msg.usage.input_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      outputTokens: msg.usage.output_tokens,
    };
    const cost = costUsd(usage, request.model);

    this.log.log(
      `${request.model} · ${elapsed}ms · ${usage.inputTokens}in/${usage.outputTokens}out · $${cost.toFixed(4)}`,
    );

    const toolUse = msg.content.find((b) => b.type === 'tool_use');
    const textBlock = msg.content.find((b) => b.type === 'text');

    return {
      provider: 'anthropic',
      model: request.model,
      toolInput: toolUse && toolUse.type === 'tool_use' ? toolUse.input : undefined,
      text: textBlock && textBlock.type === 'text' ? textBlock.text : undefined,
      usage,
      costUsd: cost,
      finishReason:
        msg.stop_reason === 'tool_use'
          ? 'tool_use'
          : msg.stop_reason === 'max_tokens'
            ? 'length'
            : msg.stop_reason === 'end_turn'
              ? 'stop'
              : 'stop',
      requestId: msg.id,
    };
  }
}

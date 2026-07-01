/**
 * The abstraction that keeps us out of a single-provider trap.
 *
 * Every agent talks to an `LLMGateway`; every backend (Anthropic, OpenAI,
 * Google, self-hosted, LiteLLM-proxy) implements the same interface. The
 * orchestrator wraps the gateway in the guardrail chain (see
 * `guards/guard-chain.ts`) so cost, rate-limit, and grounding checks are
 * enforced once, not per-agent.
 */
import { z } from 'zod';

export const modelId = z.string();
export type ModelId = z.infer<typeof modelId>;

export const messageRole = z.enum(['system', 'user', 'assistant']);
export type MessageRole = z.infer<typeof messageRole>;

export const textContentBlock = z.object({ type: z.literal('text'), text: z.string() });

/** PDF input block. The gateway handles provider-specific encoding. */
export const documentContentBlock = z.object({
  type: z.literal('document'),
  mediaType: z.literal('application/pdf'),
  data: z.string(), // base64
});

export const contentBlock = z.discriminatedUnion('type', [textContentBlock, documentContentBlock]);
export type ContentBlock = z.infer<typeof contentBlock>;

export const message = z.object({
  role: messageRole,
  content: z.union([z.string(), z.array(contentBlock)]),
});
export type Message = z.infer<typeof message>;

/**
 * Forcing structured output. When `tool` is set, the gateway will make
 * the model call this tool and return its input. The gateway does the
 * provider-specific wiring (`tool_use` for Anthropic, `functions` /
 * `response_format: json_schema` for OpenAI, etc.).
 */
export const toolSpec = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()), // JSON Schema
});
export type ToolSpec = z.infer<typeof toolSpec>;

export const llmRequest = z.object({
  model: modelId,
  system: z.string().optional(),
  messages: z.array(message),
  maxTokens: z.number().int().positive().default(4096),
  temperature: z.number().min(0).max(2).default(0),
  tool: toolSpec.optional(),
  /** Prompt fingerprint (used by prompt-schema guard). */
  promptVersion: z.string(),
  /**
   * Correlation identifiers. The gateway writes these into cost_ledger
   * and audit events so we can trace every USD back to the workflow that
   * spent it.
   */
  workflowId: z.string().uuid().optional(),
  stepId: z.string().uuid().optional(),
  orgId: z.string().uuid(),
});
export type LLMRequest = z.infer<typeof llmRequest>;

export const usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof usage>;

export const llmResponse = z.object({
  provider: z.string(), // 'anthropic', 'openai', ...
  model: modelId,
  /** Present when `tool` was set on the request. */
  toolInput: z.unknown().optional(),
  /** Present when `tool` was NOT set. */
  text: z.string().optional(),
  usage,
  /** USD cost the gateway computed from provider pricing sheets. */
  costUsd: z.number().nonnegative(),
  finishReason: z.enum(['stop', 'length', 'tool_use', 'content_policy']),
  requestId: z.string(),
});
export type LLMResponse = z.infer<typeof llmResponse>;

/**
 * Backend interface — every provider implements this. The gateway itself
 * is a thin router that picks a backend based on the model id (and,
 * eventually, on availability + cost policy).
 */
export interface LLMBackend {
  readonly provider: string;
  supports(model: ModelId): boolean;
  invoke(request: LLMRequest): Promise<LLMResponse>;
}

/** The gateway. All agents call this; nothing else. */
export interface LLMGateway {
  call(request: LLMRequest): Promise<LLMResponse>;
}

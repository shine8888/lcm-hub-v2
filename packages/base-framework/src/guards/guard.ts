/**
 * The guardrail primitive.
 *
 * Guards compose. Every call to `llm-gateway.call()` from the orchestrator
 * flows through a chain of guards — rate-limit → cost-budget →
 * prompt-schema → content-policy → [actual call] → grounding → audit.
 *
 * A guard that fails short-circuits the chain with a typed reason. The
 * orchestrator's retry policy differs per reason (see
 * `contracts/workflow.contract.ts.stepFailureReason`).
 */
import type { StepFailureReason } from '../contracts/workflow.contract';

export type GuardVerdict<T> =
  | { ok: true; value: T }
  | { ok: false; reason: StepFailureReason; message: string; details?: Record<string, unknown> };

/**
 * A guard is a policy over an input/output pair.
 *
 * - `preflight` runs before the call. Returning !ok halts the chain.
 * - `postflight` runs after the call. Returning !ok marks the step as
 *   failed even if the call itself succeeded (e.g. grounding guard
 *   catches a plausible-but-ungrounded LLM response).
 *
 * Guards that only need one hook can leave the other undefined.
 */
export interface Guard<TIn, TOut> {
  readonly name: string;
  preflight?(input: TIn): Promise<GuardVerdict<TIn>>;
  postflight?(input: TIn, output: TOut): Promise<GuardVerdict<TOut>>;
}

/**
 * Compose a chain around an action. Preflight guards run in order; the
 * action runs; postflight guards run in *reverse* order (like middleware).
 */
export async function runGuarded<TIn, TOut>(
  guards: Guard<TIn, TOut>[],
  input: TIn,
  action: (input: TIn) => Promise<TOut>,
): Promise<GuardVerdict<TOut>> {
  let current: TIn = input;
  for (const g of guards) {
    if (!g.preflight) continue;
    const verdict = await g.preflight(current);
    if (!verdict.ok) return verdict;
    current = verdict.value;
  }

  let output: TOut;
  try {
    output = await action(current);
  } catch (e) {
    return {
      ok: false,
      reason: 'provider_error',
      message: (e as Error).message,
      details: { name: (e as Error).name, stack: (e as Error).stack },
    };
  }

  for (let i = guards.length - 1; i >= 0; i--) {
    const g = guards[i];
    if (!g.postflight) continue;
    const verdict = await g.postflight(current, output);
    if (!verdict.ok) return verdict;
    output = verdict.value;
  }
  return { ok: true, value: output };
}

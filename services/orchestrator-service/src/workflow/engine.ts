import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import type {
  StepDispatchMessage,
  StepResultMessage,
  WorkflowDefinition,
  WorkflowKind,
} from '@lcm/base-framework';
import {
  AGENT_STEP_DISPATCH,
  CLIENT_TOKENS,
  agentQueue,
} from '@lcm/base-framework';

import { WorkflowRepository, type PersistedStep } from '../db/workflow.repo';

/**
 * The DAG engine.
 *
 * Runs each workflow as a sequence of steps in the order defined by
 * `WorkflowDefinition.edges`. Fan-out steps are dispatched in parallel;
 * the engine advances past a fan-out group only when every parallel
 * instance has completed. Step results come back via
 * `agent.step.result` messages (see `StepResultHandler`).
 *
 * Design note: the engine is stateless. State lives in Postgres
 * (`workflow_steps`); the engine only reads/mutates it. This means
 * multiple orchestrator instances can run — they'll compete for step
 * dispatch via `claimStep()`, which is a single UPDATE with a WHERE
 * clause on `status = 'pending'`.
 */
@Injectable()
export class WorkflowEngine {
  private readonly log = new Logger(WorkflowEngine.name);

  constructor(
    private readonly repo: WorkflowRepository,
    // Every agent has its own RabbitMQ queue. The engine grabs the right
    // client by the step's `agent` field.
    @Inject(CLIENT_TOKENS.ORCHESTRATOR_SERVICE) private readonly _self: ClientProxy,
  ) {}

  /**
   * Submit a new workflow: persist it, kick off the first step group.
   */
  async submit(input: {
    orgId: string;
    kind: WorkflowKind;
    inputRef: string;
    definition: WorkflowDefinition;
    initialInput?: Record<string, unknown>;
  }): Promise<{ workflowId: string }> {
    const { workflowId, steps } = await this.repo.createWorkflow({
      orgId: input.orgId,
      kind: input.kind,
      inputRef: input.inputRef,
      definition: input.definition,
    });
    if (input.initialInput) {
      // Merge initial input into the first step's input row (documentId, etc.)
      const first = firstStepGroup(input.definition, steps);
      for (const s of first) {
        // eslint-disable-next-line no-param-reassign
        s.input = { ...s.input, ...input.initialInput };
      }
    }
    await this.repo.setWorkflowStatus(workflowId, 'running');
    for (const step of firstStepGroup(input.definition, steps)) {
      await this.dispatch(step);
    }
    return { workflowId };
  }

  /**
   * Handle a step result. Move the step to its final status, then
   * evaluate whether the next step group is ready to dispatch.
   */
  async handleStepResult(result: StepResultMessage, definition: WorkflowDefinition): Promise<void> {
    const summary =
      result.status === 'completed'
        ? `✓ ${result.output ? '(output payload attached)' : ''}`
        : `✗ ${result.error?.reason}: ${result.error?.message}`;
    this.log.log(`step ${result.stepId.slice(0, 8)} → ${result.status} ${summary}`);

    await this.repo.completeStep(result.stepId, result.status === 'completed' ? 'completed' : 'failed', {
      output: result.output,
      failureReason: result.error?.reason,
      costUsd: result.usage?.costUsd,
    });

    // Reload all steps to compute readiness. Small DAGs → cheap query.
    const steps = await this.repo.listPendingSteps(result.workflowId);
    const doneNames = new Set(
      steps.filter((s) => s.status === 'completed').map((s) => s.stepName),
    );
    const anyFailed = steps.some((s) => s.status === 'failed');
    if (anyFailed) {
      await this.repo.setWorkflowStatus(result.workflowId, 'failed');
      return;
    }
    if (steps.every((s) => s.status === 'completed')) {
      await this.repo.setWorkflowStatus(result.workflowId, 'completed');
      return;
    }

    // Find the next group of ready-to-dispatch steps.
    const nextReady = readySteps(definition, steps, doneNames);
    for (const step of nextReady) {
      await this.dispatch(step);
    }
  }

  private async dispatch(step: PersistedStep): Promise<void> {
    const claimed = await this.repo.claimStep(step.id);
    if (!claimed) return; // already picked up by another orchestrator
    const msg: StepDispatchMessage = {
      workflowId: claimed.workflowId,
      stepId: claimed.id,
      agent: claimed.agent,
      input: claimed.input,
      attempt: claimed.attempts,
    };
    this.log.log(`dispatch ${msg.stepId.slice(0, 8)} → ${msg.agent} (${msg.workflowId.slice(0, 8)})`);
    // Emit — fire and forget. The agent replies via its own message
    // pattern on `agent.step.result`, handled by StepResultHandler.
    this._self.emit(agentQueue(msg.agent), msg);
    void AGENT_STEP_DISPATCH; // constant kept for symmetry with contracts
  }
}

// -- helpers --------------------------------------------------------

function firstStepGroup(def: WorkflowDefinition, steps: PersistedStep[]): PersistedStep[] {
  const targets = new Set(def.edges.map((e) => e.to));
  const roots = def.steps.filter((s) => !targets.has(s.name)).map((s) => s.name);
  return steps.filter((s) => roots.includes(s.stepName));
}

function readySteps(
  def: WorkflowDefinition,
  steps: PersistedStep[],
  doneNames: Set<string>,
): PersistedStep[] {
  const dependsOn = new Map<string, string[]>();
  for (const e of def.edges) {
    const arr = dependsOn.get(e.to) ?? [];
    arr.push(e.from);
    dependsOn.set(e.to, arr);
  }
  const ready: PersistedStep[] = [];
  for (const s of steps) {
    if (s.status !== 'pending') continue;
    const deps = dependsOn.get(s.stepName) ?? [];
    if (deps.every((d) => doneNames.has(d))) ready.push(s);
  }
  return ready;
}

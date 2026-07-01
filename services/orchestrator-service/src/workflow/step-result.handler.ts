import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { AGENT_STEP_RESULT, stepResultMessage, type StepResultMessage } from '@lcm/base-framework';

import { EXTRACT_EPD_WORKFLOW } from './definitions';
import { WorkflowEngine } from './engine';

/**
 * Consumes `agent.step.result` messages from agents and hands them to
 * the engine. In the vertical slice we hard-wire the extraction
 * workflow definition; in v2 we'd load the definition from the
 * `workflows.definition` JSONB column.
 */
@Controller()
export class StepResultHandler {
  private readonly log = new Logger(StepResultHandler.name);

  constructor(private readonly engine: WorkflowEngine) {}

  @MessagePattern(AGENT_STEP_RESULT)
  async onStepResult(@Payload() payload: unknown): Promise<void> {
    const parsed = stepResultMessage.safeParse(payload);
    if (!parsed.success) {
      this.log.error(`invalid step result: ${JSON.stringify(parsed.error.issues)}`);
      return;
    }
    const result: StepResultMessage = parsed.data;
    await this.engine.handleStepResult(result, EXTRACT_EPD_WORKFLOW);
  }
}

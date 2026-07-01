import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { z } from 'zod';

import { ORCHESTRATOR_PATTERNS } from '@lcm/base-framework';

import { EXTRACT_EPD_WORKFLOW } from './definitions';
import { WorkflowEngine } from './engine';

const submitInput = z.object({
  orgId: z.string().uuid(),
  documentId: z.string().uuid(),
  documentBase64: z.string().min(1), // for the vertical slice, pass PDF inline
});
type SubmitInput = z.infer<typeof submitInput>;

@Controller()
export class SubmitController {
  private readonly log = new Logger(SubmitController.name);

  constructor(private readonly engine: WorkflowEngine) {}

  @MessagePattern(ORCHESTRATOR_PATTERNS.SUBMIT_WORKFLOW)
  async submit(@Payload() payload: unknown): Promise<{ workflowId: string }> {
    const parsed = submitInput.safeParse(payload);
    if (!parsed.success) {
      throw new RpcException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'invalid_workflow_input',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const input: SubmitInput = parsed.data;
    this.log.log(`submit extract-epd org=${input.orgId} doc=${input.documentId}`);
    return this.engine.submit({
      orgId: input.orgId,
      kind: 'extract-epd',
      inputRef: input.documentId,
      definition: EXTRACT_EPD_WORKFLOW,
      initialInput: {
        documentId: input.documentId,
        documentBase64: input.documentBase64,
      },
    });
  }
}

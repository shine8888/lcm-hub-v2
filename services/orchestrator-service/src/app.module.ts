import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { CLIENT_TOKENS, SERVICE_QUEUES, requireEnv } from '@lcm/base-framework';

import { PgModule } from './db/pg';
import { WorkflowRepository } from './db/workflow.repo';
import { WorkflowEngine } from './workflow/engine';
import { SubmitController } from './workflow/submit.controller';
import { StepResultHandler } from './workflow/step-result.handler';
import { CostBudgetGuard } from './guards/cost-budget.guard';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { GroundingGuard } from './guards/grounding.guard';
import { AuditEmitGuard } from './guards/audit-emit.guard';
import { GuardedLLMService } from './guards/guarded-llm.service';

@Module({
  imports: [
    PgModule,
    ClientsModule.registerAsync([
      {
        name: CLIENT_TOKENS.LLM_GATEWAY,
        useFactory: () => ({
          transport: Transport.RMQ,
          options: {
            urls: [requireEnv('RABBITMQ_URL')],
            queue: SERVICE_QUEUES.LLM_GATEWAY,
            queueOptions: { durable: true },
          },
        }),
      },
      {
        // Self-connection so the engine can emit dispatch messages onto
        // agent queues. Nest wants a ClientProxy for `.emit()`; we point
        // it at the orchestrator's own connection.
        name: CLIENT_TOKENS.ORCHESTRATOR_SERVICE,
        useFactory: () => ({
          transport: Transport.RMQ,
          options: {
            urls: [requireEnv('RABBITMQ_URL')],
            queue: SERVICE_QUEUES.ORCHESTRATOR_SERVICE,
            queueOptions: { durable: true },
          },
        }),
      },
    ]),
  ],
  controllers: [SubmitController, StepResultHandler],
  providers: [
    WorkflowRepository,
    WorkflowEngine,
    CostBudgetGuard,
    RateLimitGuard,
    GroundingGuard,
    AuditEmitGuard,
    GuardedLLMService,
  ],
})
export class AppModule {}

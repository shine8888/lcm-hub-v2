import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { CLIENT_TOKENS, SERVICE_QUEUES, requireEnv } from '@lcm/base-framework';

import { ExtractorController } from './extractor/extractor.controller';

@Module({
  imports: [
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
  controllers: [ExtractorController],
})
export class AppModule {}

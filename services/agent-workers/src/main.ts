import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';

import { agentQueue, requireEnv } from '@lcm/base-framework';

import { AppModule } from './app.module';

/**
 * agent-workers hosts one process per agent kind. In dev we run them
 * all in this single Nest microservice for developer convenience; in
 * prod each agent runs as its own deployment with its own replica
 * count, memory, and rate-limit (see docs/SCALE.md).
 *
 * The queue this process subscribes to is `agents.extractor-agent`.
 * Adding triage-agent + verifier-agent = new controller classes +
 * new EventPattern queues; NO change to this bootstrap.
 */
async function bootstrap() {
  const rabbitmqUrl = requireEnv('RABBITMQ_URL');
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl],
      queue: agentQueue('extractor-agent'),
      queueOptions: { durable: true },
      noAck: false,
    },
  });
  await app.listen();
  // eslint-disable-next-line no-console
  console.log(`[agent-workers] extractor-agent listening on "${agentQueue('extractor-agent')}"`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[agent-workers] bootstrap failed:', e);
  process.exit(1);
});

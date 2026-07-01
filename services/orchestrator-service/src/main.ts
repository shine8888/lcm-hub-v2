import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';

import { requireEnv, SERVICE_QUEUES } from '@lcm/base-framework';

import { AppModule } from './app.module';

async function bootstrap() {
  const rabbitmqUrl = requireEnv('RABBITMQ_URL');
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl],
      queue: SERVICE_QUEUES.ORCHESTRATOR_SERVICE,
      queueOptions: { durable: true },
      noAck: false,
    },
  });
  await app.listen();
  // eslint-disable-next-line no-console
  console.log(`[orchestrator-service] listening on queue "${SERVICE_QUEUES.ORCHESTRATOR_SERVICE}"`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[orchestrator-service] bootstrap failed:', e);
  process.exit(1);
});

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
      queue: SERVICE_QUEUES.LLM_GATEWAY,
      queueOptions: { durable: true },
      noAck: false,
    },
  });
  await app.listen();
  // eslint-disable-next-line no-console
  console.log(`[llm-gateway] listening on queue "${SERVICE_QUEUES.LLM_GATEWAY}"`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[llm-gateway] bootstrap failed:', e);
  process.exit(1);
});

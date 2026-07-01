/**
 * End-to-end demo: submit a real EPD PDF through the extraction workflow.
 *
 * Usage:
 *   npm run stack:up                               # bring the stack online
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *     npx tsx scripts/e2e/submit.ts path/to/epd.pdf
 *
 * The script:
 *   1. Reads the PDF, base64s it, generates a fake documentId.
 *   2. Sends `orchestrator.workflows.submit` via RabbitMQ ClientProxy.
 *   3. Polls the workflow row until status = completed | failed.
 *   4. Prints the terminal state + cost.
 *
 * The api-gateway would normally be the entry point (with an
 * Idempotency-Key + a real document-service upload). This script skips
 * both to prove the orchestrator + agent + gateway loop works.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { ClientProxyFactory, Transport, ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  ORCHESTRATOR_PATTERNS,
  SERVICE_QUEUES,
  requireEnv,
} from '../../packages/base-framework/src';

const DEV_ORG_ID = '00000000-0000-0000-0000-000000000001';

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: npx tsx scripts/e2e/submit.ts path/to/epd.pdf');
    process.exit(2);
  }
  const rabbitmqUrl = requireEnv('RABBITMQ_URL');
  const databaseUrl = requireEnv('DATABASE_URL');

  const pdf = readFileSync(pdfPath);
  const documentId = randomUUID();
  console.log(`→ submitting document ${documentId.slice(0, 8)} (${(pdf.length / 1024 / 1024).toFixed(2)} MB)`);

  const client: ClientProxy = ClientProxyFactory.create({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl],
      queue: SERVICE_QUEUES.ORCHESTRATOR_SERVICE,
      queueOptions: { durable: true },
    },
  });
  await client.connect();

  const submitStart = Date.now();
  const { workflowId } = await firstValueFrom(
    client.send<{ workflowId: string }>(ORCHESTRATOR_PATTERNS.SUBMIT_WORKFLOW, {
      orgId: DEV_ORG_ID,
      documentId,
      documentBase64: pdf.toString('base64'),
    }),
  );
  console.log(`✓ workflow=${workflowId} submitted in ${Date.now() - submitStart}ms`);

  await client.close();

  // Poll the DB for terminal status. In prod the caller would subscribe
  // to a status event or the api-gateway would surface a Server-Sent
  // Events stream — polling is only for this demo script.
  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  try {
    for (let i = 0; i < 240; i++) {
      const res = await pg.query<{ status: string; cost_usd: string }>(
        `SELECT status, cost_usd::text FROM orchestrator_service.workflows WHERE id = $1`,
        [workflowId],
      );
      const row = res.rows[0];
      const steps = await pg.query<{ step_name: string; fan_index: number; status: string; cost_usd: string }>(
        `SELECT step_name, fan_index, status, cost_usd::text
           FROM orchestrator_service.workflow_steps
          WHERE workflow_id = $1 ORDER BY step_name, fan_index`,
        [workflowId],
      );
      const step_summary = steps.rows.map((s) => `${s.step_name}[${s.fan_index}]=${s.status}`).join(' ');
      console.log(`[${i.toString().padStart(3, '0')}s] wf=${row.status} $${Number(row.cost_usd).toFixed(4)}   ${step_summary}`);
      if (row.status === 'completed' || row.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await pg.end();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

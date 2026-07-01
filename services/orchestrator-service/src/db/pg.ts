import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';

import { requireEnv } from '@lcm/base-framework';

export const PG_POOL = Symbol('PG_POOL');

const poolFactory = () =>
  new Pool({
    connectionString: requireEnv('DATABASE_URL'),
    max: 10,
  });

@Global()
@Module({
  providers: [{ provide: PG_POOL, useFactory: poolFactory }],
  exports: [PG_POOL],
})
export class PgModule {}

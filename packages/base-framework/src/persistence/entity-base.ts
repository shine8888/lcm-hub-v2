/**
 * Every persisted entity extends `EntityBase` — uuid PK + timestamps.
 * Keeps TypeORM/Prisma decorators out of shared code; concrete
 * subclasses pick their ORM at the service boundary.
 */
export abstract class EntityBase {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
}

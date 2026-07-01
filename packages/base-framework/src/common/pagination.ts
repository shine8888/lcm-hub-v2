import { z } from 'zod';

export const paginationInput = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(20),
});
export type PaginationInput = z.infer<typeof paginationInput>;

export interface Paginated<T> {
  data: T[];
  paging: { page: number; pageSize: number; total: number };
}

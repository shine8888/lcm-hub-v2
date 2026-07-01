/**
 * The 7-tuple that makes extractions idempotent.
 *
 * Same PDF + same prompt + same model + same schema = same version_key.
 * The UNIQUE index on `extractions.version_key` collapses retries into
 * one row and lets prompt/schema revisions coexist with old data
 * (see `is_live` + `superseded_by` in the DB schema).
 */
import { createHash } from 'node:crypto';

export interface VersionKeyInput {
  documentId: string;
  documentRevision: number;
  extractorName: string;
  modelId: string;
  promptVersion: string;
  schemaVersion: string;
  chunkConfig?: string;
}

export function computeVersionKey(input: VersionKeyInput): string {
  const parts = [
    input.documentId,
    String(input.documentRevision),
    input.extractorName,
    input.modelId,
    input.promptVersion,
    input.schemaVersion,
    input.chunkConfig ?? 'default',
  ].join('\x1f'); // unit separator — unambiguous
  return createHash('sha256').update(parts).digest('hex');
}

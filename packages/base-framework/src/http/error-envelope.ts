/**
 * The one HTTP error shape the platform emits. Any client that speaks the
 * platform's REST API can pattern-match on `error` + `code`.
 */
export interface ErrorEnvelope {
  statusCode: number;
  error: string;
  code?: string;
  message: string | string[];
  requestId?: string;
  details?: Record<string, unknown>;
}

/**
 * Every RabbitMQ MessagePattern in the system, in one file. New patterns
 * are added here, not sprinkled across services — the constant is the
 * single source of truth on both sides of any RPC call.
 */

// -- Domain services (request/response) -----------------------------

export const DOCUMENT_PATTERNS = {
  UPLOAD: 'documents.upload',
  GET_BY_ID: 'documents.getById',
  GET_BY_HASH: 'documents.getByHash',
} as const;

export const MATERIALS_PATTERNS = {
  PERSIST_EXTRACTION: 'materials.extractions.persist',
  GET_EXTRACTION: 'materials.extractions.get',
  LIST_MATERIALS: 'materials.list',
  COMPARE_MATERIALS: 'materials.compare',
  PROMOTE_STAGED: 'materials.extractions.promoteStaged',
} as const;

export const ORCHESTRATOR_PATTERNS = {
  SUBMIT_WORKFLOW: 'orchestrator.workflows.submit',
  GET_WORKFLOW: 'orchestrator.workflows.get',
  CANCEL_WORKFLOW: 'orchestrator.workflows.cancel',
} as const;

export const LLM_GATEWAY_PATTERNS = {
  CALL: 'llm.gateway.call',
  ESTIMATE_COST: 'llm.gateway.estimateCost',
} as const;

// -- Agent workers (dispatched by orchestrator, consumed by agents) --

export const AGENT_QUEUE_PREFIX = 'agents';

/** e.g. queue name "agents.extractor-agent". */
export function agentQueue(name: string): string {
  return `${AGENT_QUEUE_PREFIX}.${name}`;
}

export const AGENT_STEP_DISPATCH = 'agent.step.dispatch';
export const AGENT_STEP_RESULT = 'agent.step.result';

// -- Service queue names --------------------------------------------

export const SERVICE_QUEUES = {
  DOCUMENT_SERVICE: 'document-service',
  MATERIALS_SERVICE: 'materials-service',
  ORCHESTRATOR_SERVICE: 'orchestrator-service',
  LLM_GATEWAY: 'llm-gateway',
} as const;

// -- Client tokens for NestJS ClientProxy DI ------------------------

export const CLIENT_TOKENS = {
  DOCUMENT_SERVICE: 'DOCUMENT_SERVICE',
  MATERIALS_SERVICE: 'MATERIALS_SERVICE',
  ORCHESTRATOR_SERVICE: 'ORCHESTRATOR_SERVICE',
  LLM_GATEWAY: 'LLM_GATEWAY',
} as const;

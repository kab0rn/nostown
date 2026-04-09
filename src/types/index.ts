// NOS Town — Shared Types

export type BeadStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'failed';

export type BeadOutcome = 'SUCCESS' | 'FAILURE';

export interface BeadMetrics {
  test_pass?: boolean;
  witness_score?: number;
  duration_ms?: number;
  tokens?: number;
}

export interface Bead {
  bead_id: string;
  role: string;
  task_type: string;
  model: string;
  status: BeadStatus;
  needs: string[];              // prerequisite bead_ids
  witness_required: boolean;
  critical_path: boolean;
  fan_out_weight: number;
  plan_checkpoint_id?: string;
  outcome?: BeadOutcome;
  metrics?: BeadMetrics;
  checksum?: string;            // sha256(JSON.stringify(bead_without_checksum))
  created_at: string;
  updated_at?: string;
  rig?: string;
  task_description?: string;
}

export type ConvoyType =
  // Mayor
  | 'BEAD_DISPATCH' | 'SWARM_ABORT' | 'CAPACITY_UPDATE' | 'LOCKDOWN_BROADCAST'
  // Polecat
  | 'BEAD_STATUS' | 'DISCOVERY' | 'BLOCKED' | 'PATCH_READY'
  // Witness
  | 'REVIEW_VERDICT' | 'COUNCIL_VOTE' | 'REVIEW_RETRY'
  // Safeguard
  | 'SECURITY_VIOLATION' | 'LOCKDOWN_TRIGGERED' | 'WRITE_APPROVED' | 'WRITE_REJECTED'
  // Historian
  | 'ROUTING_UPDATE' | 'PLAYBOOK_PUBLISHED' | 'BACKFILL_NOTICE';

export interface ConvoyHeader {
  sender_id: string;     // e.g. "mayor_01"
  recipient: string;
  timestamp: string;
  seq: number;
  trace_id?: string;
  parent_span_id?: string;
}

export interface ConvoyPayload {
  type: ConvoyType;
  data: Record<string, unknown>;
}

export interface ConvoyMessage {
  header: ConvoyHeader;
  payload: ConvoyPayload;
  signature: string;          // "ed25519:base64..."
  transport_mac?: string;     // "hmac256:hex..." (optional)
}

export type TripleClass = 'critical' | 'advisory' | 'historical';

export interface KGTriple {
  id?: number;
  subject: string;
  relation: string;
  object: string;
  valid_from: string;
  valid_to?: string;
  agent_id: string;
  metadata?: Record<string, unknown>; // MUST include { class: TripleClass }
  created_at: string;
}

export type HeartbeatEvent =
  | { type: 'POLECAT_STALLED'; bead_id: string; agent_id: string; stall_duration_ms: number }
  | { type: 'BEAD_BLOCKED'; bead_id: string; retry_count: number }
  | { type: 'PROVIDER_EXHAUSTED'; model: string; error: string }
  | { type: 'PROVIDER_RECOVERED'; recovered_at: string }
  | { type: 'MODEL_DEPRECATED'; model: string; fallback: string }
  | { type: 'MAYOR_MISSING'; last_seen_at: string; active_convoy_id: string }
  | { type: 'POTENTIAL_DEADLOCK'; bead_id: string; stall_duration_ms: number; reason: 'HIGH_FAN_OUT' | 'SOLE_PREDECESSOR' | 'STARVATION' };

export interface TriggerFilter {
  beadId?: string;
  role?: string;
  outcomeType?: BeadOutcome;
}

export interface TriggerPattern {
  event: string;
  filter?: TriggerFilter;
}

export interface ActionDefinition {
  type: 'MCP_TOOL' | 'CONVOY' | 'KG_QUERY' | 'CUSTOM';
  payload: Record<string, unknown>;
}

export interface Hook {
  id: string;
  role: string;
  trigger: TriggerPattern;
  action: ActionDefinition;
  context?: Record<string, unknown>;
  enabled?: boolean;
  priority?: number;
}

export interface AgentCheckpoint {
  checkpoint_id: string;
  agent_id: string;
  plan: Record<string, unknown>;
  created_at: string;
  bead_ids: string[];
}

export interface BeadEvent {
  beadId: string;
  outcome?: BeadOutcome;
  timestamp: string;
  role?: string;
  modelId?: string;
  [key: string]: unknown;
}

export interface InferenceParams {
  role: string;
  model?: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  max_tokens?: number;
  task_type?: string;
  response_format?: { type: 'json_object' };
}

export interface ReviewVerdict {
  approved: boolean;
  score: string;         // e.g. "3/3"
  reason?: string;
  votes: Array<{
    judge_id: string;
    approved: boolean;
    comment?: string;
  }>;
}

export interface ScanResult {
  approved: boolean;
  violations: Array<{
    rule: string;
    severity: 'critical' | 'high' | 'medium';
    detail: string;
  }>;
}

export interface PlaybookEntry {
  id: string;
  title: string;
  task_type: string;
  steps: string[];
  model_hint?: string;
  created_at: string;
}

export const ROLE_PRECEDENCE: Record<string, number> = {
  historian: 5,
  mayor: 4,
  witness: 3,
  safeguard: 2,
  polecat: 1,
};

// NOS Town — Structured JSON Logger
// Per OBSERVABILITY.md §3: all agents MUST log in JSON format to stdout.

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface StructuredLog {
  timestamp: string;
  level: LogLevel;
  role: string;
  agent_id: string;
  trace_id?: string;
  event: string;
  bead_id?: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Write a structured JSON log entry to stdout.
 * In production this is captured by the NOS Town logging sidecar.
 */
export function structuredLog(entry: Omit<StructuredLog, 'timestamp'>): void {
  const full = {
    timestamp: new Date().toISOString(),
    ...entry,
  } as StructuredLog;
  process.stdout.write(JSON.stringify(full) + '\n');
}

/**
 * Create a bound logger for a specific agent.
 * Returns a log function pre-filled with role and agent_id.
 */
export function createLogger(role: string, agentId: string) {
  return function log(
    level: LogLevel,
    event: string,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    structuredLog({ level, role, agent_id: agentId, event, message, ...extra });
  };
}

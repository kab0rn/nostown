// NOS Town — Structured JSON Logger
// Per OBSERVABILITY.md §3: all agents MUST log in JSON format to stdout.
//
// Runtime verbosity is controlled by NOS_LOG_LEVEL (default: INFO).
// Valid values: DEBUG | INFO | WARN | ERROR
// Set NOS_LOG_LEVEL=DEBUG to enable verbose decomposition / routing trace logs.

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

const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/**
 * Effective minimum log level from NOS_LOG_LEVEL env var (default: INFO).
 * Re-evaluated on each call so tests can change the env var dynamically.
 */
function minLevel(): LogLevel {
  const raw = (process.env.NOS_LOG_LEVEL ?? 'INFO').toUpperCase() as LogLevel;
  return LEVEL_RANK[raw] !== undefined ? raw : 'INFO';
}

/**
 * Write a structured JSON log entry to stdout.
 * Entries below the configured NOS_LOG_LEVEL are silently dropped.
 * In production this is captured by the NOS Town logging sidecar.
 */
export function structuredLog(entry: Omit<StructuredLog, 'timestamp'>): void {
  const level = entry.level as LogLevel;
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel()]) return;
  const full = {
    timestamp: new Date().toISOString(),
    ...entry,
  } as StructuredLog;
  process.stdout.write(JSON.stringify(full) + '\n');
}

/**
 * Create a bound logger for a specific agent.
 * Returns a log function pre-filled with role and agent_id.
 * All calls below NOS_LOG_LEVEL are no-ops.
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

// NOS Town — Input Sanitization
// Guards against injection, oversized inputs, and dangerous patterns.

/**
 * Maximum safe string lengths for various input contexts.
 */
export const MAX_LENGTHS = {
  taskDescription: 2000,
  hookPayloadValue: 500,
  rigName: 64,
  agentId: 64,
  beadId: 128,
  modelName: 128,
  diff: 50_000,
} as const;

/**
 * Patterns that must never appear in substituted hook values.
 * Prevents shell injection, template escapes, and code execution.
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\$\{/,           // Template literal injection
  /`[^`]*`/,        // Backtick execution
  /;\s*(rm|del|drop|exec|eval)/i,  // Command chaining
  /<script/i,       // XSS
  /\.\.\//,         // Path traversal
];

/**
 * Sanitize a string value for use in hook payload substitution.
 * Truncates to max length and rejects dangerous patterns.
 * Returns null if the value is unsafe.
 */
export function sanitizeHookValue(value: string, maxLength = MAX_LENGTHS.hookPayloadValue): string | null {
  if (typeof value !== 'string') return null;

  const truncated = value.slice(0, maxLength);

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(truncated)) {
      console.warn(`[Sanitize] Blocked dangerous pattern in hook value: ${pattern.toString()}`);
      return null;
    }
  }

  return truncated;
}

/**
 * Sanitize a rig name: alphanumeric, hyphens, underscores only.
 */
export function sanitizeRigName(name: string): string | null {
  if (typeof name !== 'string') return null;
  const cleaned = name.slice(0, MAX_LENGTHS.rigName);
  return /^[a-zA-Z0-9_-]+$/.test(cleaned) ? cleaned : null;
}

/**
 * Sanitize an agent ID.
 */
export function sanitizeAgentId(id: string): string | null {
  if (typeof id !== 'string') return null;
  const cleaned = id.slice(0, MAX_LENGTHS.agentId);
  return /^[a-zA-Z0-9_-]+$/.test(cleaned) ? cleaned : null;
}

/**
 * Sanitize a task description (free text, length-limited).
 */
export function sanitizeTaskDescription(desc: string): string {
  if (typeof desc !== 'string') return '';
  return desc.slice(0, MAX_LENGTHS.taskDescription);
}

/**
 * Sanitize a code diff before safeguard scanning.
 * Truncates oversized diffs to avoid LLM context overflow.
 */
export function sanitizeDiff(diff: string): string {
  if (typeof diff !== 'string') return '';
  return diff.slice(0, MAX_LENGTHS.diff);
}

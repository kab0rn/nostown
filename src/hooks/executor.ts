// NOS Town — Hook Executor with secure variable substitution

import type { Hook, BeadEvent } from '../types/index.js';

// Allow-list of substitutable variable paths to prevent injection
const ALLOWED_VAR_PATHS = new Set([
  'event.beadId',
  'event.outcome',
  'event.timestamp',
  'event.role',
  'event.modelId',
]);

/**
 * Securely substitute {{variable}} placeholders in a string.
 * Only allow-listed paths are substituted.
 */
export function substituteVars(
  template: string,
  event: BeadEvent,
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, varPath: string) => {
    const trimmed = varPath.trim();

    if (!ALLOWED_VAR_PATHS.has(trimmed)) {
      console.warn(`[HookExecutor] Blocked disallowed variable: ${trimmed}`);
      return match; // Return original placeholder if not allowed
    }

    // Navigate the event object by dot-separated path
    const parts = trimmed.split('.');
    let value: unknown = { event };
    for (const part of parts) {
      if (value && typeof value === 'object' && part in (value as Record<string, unknown>)) {
        value = (value as Record<string, unknown>)[part];
      } else {
        return match; // Path not found — return original
      }
    }

    return String(value ?? '');
  });
}

/**
 * Recursively substitute variables in a payload object.
 */
function substituteInPayload(
  payload: Record<string, unknown>,
  event: BeadEvent,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      result[key] = substituteVars(value, event);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = substituteInPayload(value as Record<string, unknown>, event);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export type ActionExecutor = (
  action: Hook['action'],
  event: BeadEvent,
) => Promise<void>;

/**
 * Execute a hook action with variable substitution.
 * Callers provide an executor for each action type.
 */
export async function executeHook(
  hook: Hook,
  event: BeadEvent,
  executor: ActionExecutor,
): Promise<void> {
  if (hook.enabled === false) return;

  const resolvedPayload = substituteInPayload(hook.action.payload, event);
  const resolvedAction = { ...hook.action, payload: resolvedPayload };

  await executor(resolvedAction, event);
}

/**
 * Check if a hook's trigger matches an event.
 */
export function matchesTrigger(hook: Hook, event: BeadEvent): boolean {
  if (hook.trigger.event !== event.type && hook.trigger.event !== '*') {
    return false;
  }

  const filter = hook.trigger.filter;
  if (!filter) return true;

  if (filter.beadId && filter.beadId !== event.beadId) return false;
  if (filter.role && filter.role !== event.role) return false;
  if (filter.outcomeType && filter.outcomeType !== event.outcome) return false;

  return true;
}

/**
 * Run all matching hooks for an event.
 */
export async function runMatchingHooks(
  hooks: Hook[],
  event: BeadEvent,
  executor: ActionExecutor,
): Promise<void> {
  const matching = hooks
    .filter((h) => h.enabled !== false && matchesTrigger(h, event))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  for (const hook of matching) {
    try {
      await executeHook(hook, event, executor);
    } catch (err) {
      console.error(`[HookExecutor] Error in hook ${hook.id}: ${String(err)}`);
    }
  }
}

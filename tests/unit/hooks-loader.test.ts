// Tests: Hook loader, validator, executor — Gate 5

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { loadHooks, loadHooksForRole } from '../../src/hooks/loader';
import { validateHook, isValidHook } from '../../src/hooks/validator';
import {
  substituteVars,
  matchesTrigger,
  executeHook,
  runMatchingHooks,
} from '../../src/hooks/executor';
import type { Hook, BeadEvent } from '../../src/types/index';

const TEST_HOOKS_DIR = path.join(os.tmpdir(), `nos-hooks-${Date.now()}`);

const SAMPLE_HOOK: Hook = {
  id: 'hook_test_1',
  role: 'Historian',
  trigger: { event: 'BEAD_RESOLVED' },
  action: {
    type: 'MCP_TOOL',
    payload: {
      tool: 'test_tool',
      args: { beadId: '{{event.beadId}}', outcome: '{{event.outcome}}' },
    },
  },
  enabled: true,
  priority: 10,
};

const SAMPLE_EVENT: BeadEvent = {
  type: 'BEAD_RESOLVED',
  beadId: 'bead-abc-123',
  outcome: 'SUCCESS',
  timestamp: '2026-01-01T00:00:00Z',
  role: 'polecat',
  modelId: 'llama-3.1-8b-instant',
};

beforeAll(() => {
  fs.mkdirSync(TEST_HOOKS_DIR, { recursive: true });

  // Write sample hook files
  fs.writeFileSync(
    path.join(TEST_HOOKS_DIR, 'test_hook.hook'),
    JSON.stringify(SAMPLE_HOOK),
    'utf8',
  );

  const hook2: Partial<Hook> = {
    ...SAMPLE_HOOK,
    id: 'hook_test_2',
    role: 'Mayor',
    priority: 20,
    trigger: { event: 'BEAD_RESOLVED', filter: { outcomeType: 'FAILURE' } },
  };
  fs.writeFileSync(
    path.join(TEST_HOOKS_DIR, 'mayor_hook.hook'),
    JSON.stringify(hook2),
    'utf8',
  );

  // Write a disabled hook
  fs.writeFileSync(
    path.join(TEST_HOOKS_DIR, 'disabled.hook'),
    JSON.stringify({ ...SAMPLE_HOOK, id: 'hook_disabled', enabled: false }),
    'utf8',
  );

  // Write an invalid hook file
  fs.writeFileSync(
    path.join(TEST_HOOKS_DIR, 'bad.hook'),
    '{ "not": "a valid hook" }',
    'utf8',
  );
});

afterAll(() => {
  fs.rmSync(TEST_HOOKS_DIR, { recursive: true, force: true });
});

describe('Hook loader (Gate 5)', () => {
  it('loads valid hook files and skips disabled hooks', () => {
    const hooks = loadHooks(TEST_HOOKS_DIR);
    // Only enabled hooks; disabled one is excluded
    expect(hooks.every((h) => h.enabled !== false)).toBe(true);
    const ids = hooks.map((h) => h.id);
    expect(ids).not.toContain('hook_disabled');
  });

  it('skips invalid hook files without throwing', () => {
    // Should not throw even though bad.hook is invalid
    expect(() => loadHooks(TEST_HOOKS_DIR)).not.toThrow();
  });

  it('returns empty array when directory does not exist', () => {
    const hooks = loadHooks('/tmp/nonexistent-hooks-dir-xyz');
    expect(hooks).toEqual([]);
  });

  it('sorts hooks by priority descending', () => {
    const hooks = loadHooks(TEST_HOOKS_DIR);
    const priorities = hooks.map((h) => h.priority ?? 0);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
  });

  it('filters hooks by role', () => {
    const mayorHooks = loadHooksForRole('Mayor', TEST_HOOKS_DIR);
    expect(mayorHooks.every((h) => h.role.toLowerCase() === 'mayor')).toBe(true);
  });
});

describe('Hook validator', () => {
  it('validates a well-formed hook', () => {
    expect(isValidHook(SAMPLE_HOOK)).toBe(true);
  });

  it('rejects a hook missing required fields', () => {
    expect(isValidHook({ id: 'incomplete' })).toBe(false);
  });

  it('rejects a hook with invalid trigger event', () => {
    const bad = { ...SAMPLE_HOOK, trigger: { event: '' } };
    expect(isValidHook(bad)).toBe(false);
  });

  it('throws with descriptive message for invalid hook', () => {
    expect(() => validateHook({ foo: 'bar' })).toThrow(/Invalid hook schema/);
  });
});

describe('Hook executor', () => {
  it('substitutes allowed event variables', () => {
    const result = substituteVars('bead:{{event.beadId}} ok:{{event.outcome}}', SAMPLE_EVENT);
    expect(result).toBe(`bead:${SAMPLE_EVENT.beadId} ok:${SAMPLE_EVENT.outcome}`);
  });

  it('blocks disallowed variable paths (injection guard)', () => {
    const result = substituteVars('{{event.private_key}}', SAMPLE_EVENT);
    expect(result).toBe('{{event.private_key}}'); // unchanged — not substituted
  });

  it('matchesTrigger: matches by event type', () => {
    expect(matchesTrigger(SAMPLE_HOOK, SAMPLE_EVENT)).toBe(true);
  });

  it('matchesTrigger: rejects wrong event type', () => {
    const wrongEvent = { ...SAMPLE_EVENT, type: 'OTHER_EVENT' };
    expect(matchesTrigger(SAMPLE_HOOK, wrongEvent)).toBe(false);
  });

  it('matchesTrigger: filters by outcomeType', () => {
    const failureHook: Hook = {
      ...SAMPLE_HOOK,
      trigger: { event: 'BEAD_RESOLVED', filter: { outcomeType: 'FAILURE' } },
    };
    expect(matchesTrigger(failureHook, SAMPLE_EVENT)).toBe(false);
    expect(matchesTrigger(failureHook, { ...SAMPLE_EVENT, outcome: 'FAILURE' })).toBe(true);
  });

  it('executeHook calls the executor with substituted payload', async () => {
    const executedActions: Array<Hook['action']> = [];
    const executor = async (action: Hook['action']) => {
      executedActions.push(action);
    };

    await executeHook(SAMPLE_HOOK, SAMPLE_EVENT, executor);

    expect(executedActions).toHaveLength(1);
    const args = executedActions[0].payload['args'] as Record<string, string>;
    expect(args['beadId']).toBe(SAMPLE_EVENT.beadId);
    expect(args['outcome']).toBe(SAMPLE_EVENT.outcome);
  });

  it('executeHook skips disabled hooks', async () => {
    const executedActions: Array<Hook['action']> = [];
    const disabledHook: Hook = { ...SAMPLE_HOOK, enabled: false };

    await executeHook(disabledHook, SAMPLE_EVENT, async (a) => { executedActions.push(a); });

    expect(executedActions).toHaveLength(0);
  });

  it('runMatchingHooks runs only matching hooks in priority order', async () => {
    const lowHook: Hook = {
      ...SAMPLE_HOOK,
      id: 'low',
      priority: 1,
      trigger: { event: 'BEAD_RESOLVED' },
      action: { type: 'MCP_TOOL', payload: { marker: 'low' } },
    };
    const highHook: Hook = {
      ...SAMPLE_HOOK,
      id: 'high',
      priority: 99,
      trigger: { event: 'BEAD_RESOLVED' },
      action: { type: 'MCP_TOOL', payload: { marker: 'high' } },
    };
    const wrongHook: Hook = {
      ...SAMPLE_HOOK,
      id: 'wrong',
      priority: 50,
      trigger: { event: 'OTHER_EVENT' },
      action: { type: 'MCP_TOOL', payload: { marker: 'wrong' } },
    };

    const executed: string[] = [];
    await runMatchingHooks([lowHook, highHook, wrongHook], SAMPLE_EVENT, async (action) => {
      executed.push(action.payload['marker'] as string);
    });

    expect(executed).not.toContain('wrong');
    expect(executed.indexOf('high')).toBeLessThan(executed.indexOf('low'));
  });
});

describe('Hooks files in hooks/ directory', () => {
  const HOOKS_PRODUCTION_DIR = path.resolve(__dirname, '../../hooks');

  it('production hooks directory exists', () => {
    expect(fs.existsSync(HOOKS_PRODUCTION_DIR)).toBe(true);
  });

  it('all hook files in hooks/ are valid', () => {
    if (!fs.existsSync(HOOKS_PRODUCTION_DIR)) return;

    const files = fs.readdirSync(HOOKS_PRODUCTION_DIR).filter((f) => f.endsWith('.hook'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const raw = fs.readFileSync(path.join(HOOKS_PRODUCTION_DIR, file), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      expect(() => validateHook(parsed)).not.toThrow();
    }
  });
});

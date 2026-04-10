// Integration: Cross-rig tunnel safety guard (RISKS.md R-006)
// Validates that incompatible-stack tunnel results are blocked or advisory-only,
// not auto-applied. Compatible tunnels are accepted.

import { checkTunnelSafety } from '../../src/routing/dispatch';
import { detectStackFamily, areStacksCompatible } from '../../src/swarm/tools';
import { Ledger } from '../../src/ledger/index';
import type { Bead } from '../../src/types/index';

function makeBeadWithDescription(description: string): Bead {
  return Ledger.createBead({
    role: 'polecat',
    task_type: 'execute',
    task_description: description,
    model: 'test',
    rig: 'test-rig',
    status: 'done',
    outcome: 'SUCCESS',
    plan_checkpoint_id: 'ckpt-tunnel-test',
  });
}

// ── checkTunnelSafety end-to-end integration ──────────────────────────────────

describe('Cross-rig tunnel safety guard — end-to-end (R-006)', () => {
  it('blocks tunnel when room name mismatches', () => {
    const result = checkTunnelSafety('auth-migration', {
      tunnel: 'billing-refactor',  // wrong room
      sourceWing: 'wing_rig_a',
      targetWing: 'wing_rig_b',
      stackFamily: 'typescript',
    }, { expectedStackFamily: 'typescript' });

    expect(result.safe).toBe(false);
    expect(result.advisory).toBe(true);
    expect(result.reason).toMatch(/room mismatch/);
  });

  it('hard-blocks tunnel when isolation flag is set (not even advisory)', () => {
    const result = checkTunnelSafety('auth-migration', {
      tunnel: 'auth-migration',
      sourceWing: 'wing_rig_a',
      targetWing: 'wing_rig_b',
      stackFamily: 'typescript',
      isolationFlag: true,
    });

    expect(result.safe).toBe(false);
    expect(result.advisory).toBe(false); // hard block, not advisory
    expect(result.reason).toMatch(/isolation flag/);
  });

  it('blocks incompatible stack (typescript ↔ python) as advisory-only', () => {
    const result = checkTunnelSafety('auth-migration', {
      tunnel: 'auth-migration',
      sourceWing: 'wing_rig_ts',
      targetWing: 'wing_rig_py',
      stackFamily: 'python',
    }, { expectedStackFamily: 'typescript' });

    expect(result.safe).toBe(false);
    expect(result.advisory).toBe(true); // advisory, not hard-blocked
    expect(result.reason).toMatch(/stack family mismatch/i);
  });

  it('blocks stale tunnel result beyond lookback window', () => {
    const result = checkTunnelSafety('auth-migration', {
      tunnel: 'auth-migration',
      sourceWing: 'wing_rig_a',
      targetWing: 'wing_rig_b',
      stackFamily: 'typescript',
      resultAge: 20, // 20 days old — exceeds default 14-day window
    }, { expectedStackFamily: 'typescript' });

    expect(result.safe).toBe(false);
    expect(result.advisory).toBe(true);
    expect(result.reason).toMatch(/20 days old/);
  });

  it('allows tunnel when all safety checks pass', () => {
    const result = checkTunnelSafety('auth-migration', {
      tunnel: 'auth-migration',
      sourceWing: 'wing_rig_a',
      targetWing: 'wing_rig_b',
      stackFamily: 'typescript',
      resultAge: 5, // within window
    }, { expectedStackFamily: 'typescript', lookbackDays: 14 });

    expect(result.safe).toBe(true);
    expect(result.advisory).toBe(false);
  });

  it('allows tunnel with no stack specified (generic source)', () => {
    const result = checkTunnelSafety('auth-migration', {
      tunnel: 'auth-migration',
      sourceWing: 'wing_rig_a',
      targetWing: 'wing_rig_b',
      // no stackFamily — means generic
    });

    expect(result.safe).toBe(true);
  });

  it('custom lookback window is respected', () => {
    // 7-day window: resultAge=10 should fail
    const result = checkTunnelSafety('auth-migration', {
      tunnel: 'auth-migration',
      sourceWing: 'wing_rig_a',
      targetWing: 'wing_rig_b',
      resultAge: 10,
    }, { lookbackDays: 7 });

    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/10 days old/);
  });
});

// ── detectStackFamily + areStacksCompatible integration ───────────────────────

describe('Stack family detection — cross-rig compatibility (R-006)', () => {
  it('typescript rig is incompatible with python rig (blocks tunnel)', () => {
    const tsBeads = [
      makeBeadWithDescription('implement typescript interface'),
      makeBeadWithDescription('run npm test'),
      makeBeadWithDescription('fix jest mock'),
    ];
    const pyBeads = [
      makeBeadWithDescription('run pytest fixtures'),
      makeBeadWithDescription('update pip requirements'),
    ];

    const tsStack = detectStackFamily(tsBeads);
    const pyStack = detectStackFamily(pyBeads);

    expect(tsStack).toBe('typescript');
    expect(pyStack).toBe('python');
    expect(areStacksCompatible(tsStack, pyStack)).toBe(false);

    // Verify tunnel safety guard would block it
    const result = checkTunnelSafety('shared-room', {
      tunnel: 'shared-room',
      sourceWing: 'wing_py',
      targetWing: 'wing_ts',
      stackFamily: pyStack,
    }, { expectedStackFamily: tsStack });
    expect(result.safe).toBe(false);
    expect(result.advisory).toBe(true);
  });

  it('two typescript rigs are compatible (tunnel allowed)', () => {
    const tsBeads1 = [makeBeadWithDescription('implement nestjs module')];
    const tsBeads2 = [makeBeadWithDescription('add next.js page')];

    const stack1 = detectStackFamily(tsBeads1);
    const stack2 = detectStackFamily(tsBeads2);

    expect(areStacksCompatible(stack1, stack2)).toBe(true);

    const result = checkTunnelSafety('api-auth', {
      tunnel: 'api-auth',
      sourceWing: 'wing_nest',
      targetWing: 'wing_next',
      stackFamily: stack2,
    }, { expectedStackFamily: stack1 });
    expect(result.safe).toBe(true);
  });

  it('generic rig is compatible with any stack (cross-rig always allowed)', () => {
    const genericBeads: Bead[] = []; // empty → generic
    const tsBeads = [makeBeadWithDescription('use eslint typescript plugin')];

    const genericStack = detectStackFamily(genericBeads);
    const tsStack = detectStackFamily(tsBeads);

    expect(genericStack).toBe('generic');
    expect(areStacksCompatible(genericStack, tsStack)).toBe(true);
    expect(areStacksCompatible(tsStack, genericStack)).toBe(true);
  });

  it('go rig is incompatible with rust rig', () => {
    const goBeads = [makeBeadWithDescription('run goroutine benchmark')];
    const rustBeads = [makeBeadWithDescription('cargo build tokio async')];

    const goStack = detectStackFamily(goBeads);
    const rustStack = detectStackFamily(rustBeads);

    expect(goStack).toBe('go');
    expect(rustStack).toBe('rust');
    expect(areStacksCompatible(goStack, rustStack)).toBe(false);
  });
});

// Tests: Tunnel Safety Guard — checkTunnelSafety()
// Covers all 4 validation conditions from ROUTING.md §Tunnel Safety Guard

import { checkTunnelSafety } from '../../src/routing/dispatch';
import type { TunnelResult } from '../../src/routing/dispatch';

function makeResult(overrides: Partial<TunnelResult> = {}): TunnelResult {
  return {
    tunnel: 'auth-flow',
    sourceWing: 'wing_a',
    targetWing: 'wing_b',
    ...overrides,
  };
}

describe('checkTunnelSafety', () => {
  it('passes all checks for a valid tunnel result', () => {
    const result = checkTunnelSafety('auth-flow', makeResult());
    expect(result.safe).toBe(true);
    expect(result.advisory).toBe(false);
    expect(result.reason).toMatch(/passed/i);
  });

  // Condition 1: Room name match
  it('fails (advisory) when tunnel room name does not match task room', () => {
    const result = checkTunnelSafety('different-room', makeResult({ tunnel: 'auth-flow' }));
    expect(result.safe).toBe(false);
    expect(result.advisory).toBe(true);
    expect(result.reason).toMatch(/mismatch/i);
    expect(result.reason).toContain('different-room');
    expect(result.reason).toContain('auth-flow');
  });

  it('passes when tunnel room name exactly matches task room', () => {
    const result = checkTunnelSafety('auth-flow', makeResult({ tunnel: 'auth-flow' }));
    expect(result.safe).toBe(true);
  });

  // Condition 2: Isolation flag (hard block)
  it('fails with hard block (advisory=false) when isolation flag is set', () => {
    const result = checkTunnelSafety('auth-flow', makeResult({ isolationFlag: true }));
    expect(result.safe).toBe(false);
    expect(result.advisory).toBe(false);  // hard block, not advisory
    expect(result.reason).toMatch(/isolation/i);
  });

  it('passes when isolation flag is false', () => {
    const result = checkTunnelSafety('auth-flow', makeResult({ isolationFlag: false }));
    expect(result.safe).toBe(true);
  });

  it('passes when isolation flag is undefined', () => {
    const result = checkTunnelSafety('auth-flow', makeResult({ isolationFlag: undefined }));
    expect(result.safe).toBe(true);
  });

  // Condition 3: Stack family compatibility
  it('fails (advisory) when stack families differ', () => {
    const result = checkTunnelSafety(
      'auth-flow',
      makeResult({ stackFamily: 'python' }),
      { expectedStackFamily: 'node' },
    );
    expect(result.safe).toBe(false);
    expect(result.advisory).toBe(true);
    expect(result.reason).toContain('python');
    expect(result.reason).toContain('node');
  });

  it('passes when stack families match', () => {
    const result = checkTunnelSafety(
      'auth-flow',
      makeResult({ stackFamily: 'node' }),
      { expectedStackFamily: 'node' },
    );
    expect(result.safe).toBe(true);
  });

  it('skips stack check when expectedStackFamily is not provided', () => {
    const result = checkTunnelSafety(
      'auth-flow',
      makeResult({ stackFamily: 'python' }),
      {},
    );
    expect(result.safe).toBe(true);
  });

  it('skips stack check when result has no stackFamily', () => {
    const result = checkTunnelSafety(
      'auth-flow',
      makeResult({ stackFamily: undefined }),
      { expectedStackFamily: 'node' },
    );
    expect(result.safe).toBe(true);
  });

  // Condition 4: Freshness
  it('fails (advisory) when result exceeds default 14-day lookback', () => {
    const result = checkTunnelSafety('auth-flow', makeResult({ resultAge: 15 }));
    expect(result.safe).toBe(false);
    expect(result.advisory).toBe(true);
    expect(result.reason).toContain('15');
    expect(result.reason).toContain('14');
  });

  it('passes when result age is exactly at the default lookback boundary', () => {
    const result = checkTunnelSafety('auth-flow', makeResult({ resultAge: 14 }));
    expect(result.safe).toBe(true);
  });

  it('passes when result age is within the default lookback window', () => {
    const result = checkTunnelSafety('auth-flow', makeResult({ resultAge: 7 }));
    expect(result.safe).toBe(true);
  });

  it('respects custom lookbackDays option', () => {
    const result = checkTunnelSafety(
      'auth-flow',
      makeResult({ resultAge: 8 }),
      { lookbackDays: 7 },
    );
    expect(result.safe).toBe(false);
    expect(result.advisory).toBe(true);
    expect(result.reason).toContain('8');
    expect(result.reason).toContain('7');
  });

  it('passes with custom lookbackDays when within window', () => {
    const result = checkTunnelSafety(
      'auth-flow',
      makeResult({ resultAge: 6 }),
      { lookbackDays: 7 },
    );
    expect(result.safe).toBe(true);
  });

  it('passes when resultAge is undefined (no age check)', () => {
    const result = checkTunnelSafety('auth-flow', makeResult({ resultAge: undefined }));
    expect(result.safe).toBe(true);
  });

  // Priority order: room name is checked first (before isolation)
  it('fails on room mismatch before checking isolation flag', () => {
    const result = checkTunnelSafety(
      'wrong-room',
      makeResult({ tunnel: 'auth-flow', isolationFlag: true }),
    );
    // Room mismatch is checked first — advisory=true, not false (which isolation would give)
    expect(result.safe).toBe(false);
    expect(result.advisory).toBe(true);
    expect(result.reason).toMatch(/mismatch/i);
  });
});

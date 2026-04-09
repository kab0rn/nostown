// Tests: SWARM.md §1 Planning-Time Cycle Detection
// Mayor MUST reject Convoy planning passes that contain dependency cycles.

jest.mock('groq-sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })),
}));

import { detectCycles } from '../../src/swarm/tools';
import { Ledger } from '../../src/ledger/index';
import type { Bead } from '../../src/types/index';

function makeBead(id: string, needs: string[] = []): Bead {
  return Ledger.createBead({
    bead_id: id,
    role: 'polecat',
    task_type: 'execute',
    model: 'llama-3.1-8b-instant',
    rig: 'test-rig',
    status: 'pending',
    needs,
    plan_checkpoint_id: 'ckpt-cycle-test',
  });
}

describe('detectCycles() — SWARM.md §1 Planning-Time Cycle Detection', () => {
  it('returns empty array for beads with no dependencies', () => {
    const beads = [makeBead('a'), makeBead('b'), makeBead('c')];
    expect(detectCycles(beads)).toHaveLength(0);
  });

  it('returns empty array for a valid linear chain (a → b → c)', () => {
    const beads = [makeBead('a'), makeBead('b', ['a']), makeBead('c', ['b'])];
    expect(detectCycles(beads)).toHaveLength(0);
  });

  it('returns empty array for a diamond DAG (c needs a,b; d needs c)', () => {
    const beads = [
      makeBead('a'),
      makeBead('b'),
      makeBead('c', ['a', 'b']),
      makeBead('d', ['c']),
    ];
    expect(detectCycles(beads)).toHaveLength(0);
  });

  it('detects a mutual dependency cycle (a needs b, b needs a)', () => {
    const beads = [makeBead('a', ['b']), makeBead('b', ['a'])];
    const cycle = detectCycles(beads);
    expect(cycle.length).toBeGreaterThan(0);
    // Both cycle participants are reported
    expect(cycle).toContain('a');
    expect(cycle).toContain('b');
  });

  it('detects a 3-node cycle (a→b→c→a)', () => {
    const beads = [
      makeBead('a', ['c']),
      makeBead('b', ['a']),
      makeBead('c', ['b']),
    ];
    const cycle = detectCycles(beads);
    expect(cycle.length).toBeGreaterThan(0);
  });

  it('detects a cycle even when other beads are acyclic', () => {
    const beads = [
      makeBead('root'),           // no deps — clean
      makeBead('alpha', ['beta']), // part of cycle
      makeBead('beta', ['alpha']), // part of cycle
      makeBead('leaf', ['root']),  // clean
    ];
    const cycle = detectCycles(beads);
    expect(cycle.length).toBeGreaterThan(0);
    expect(cycle.some((id) => id === 'alpha' || id === 'beta')).toBe(true);
  });

  it('ignores needs references that point outside the bead set', () => {
    // "external-bead" is not in the beads array — should not cause cycle
    const beads = [makeBead('a', ['external-bead']), makeBead('b', ['a'])];
    expect(detectCycles(beads)).toHaveLength(0);
  });

  it('self-referencing bead is detected as a cycle', () => {
    const beads = [makeBead('a', ['a'])];
    const cycle = detectCycles(beads);
    expect(cycle.length).toBeGreaterThan(0);
    expect(cycle).toContain('a');
  });
});

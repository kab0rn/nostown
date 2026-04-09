// Tests: Swarm tools — Gate 7

import {
  swarmStatus,
  swarmResetBead,
  swarmAbortWorkflow,
  findForkGroups,
  isRendezvousNode,
  swarmRebalanceLimits,
  DEFAULT_IN_FLIGHT_LIMITS,
} from '../../src/swarm/tools';
import { Ledger } from '../../src/ledger/index';
import type { Bead } from '../../src/types/index';

function bead(id: string, needs: string[] = [], status: Bead['status'] = 'pending', outcome?: Bead['outcome']): Bead {
  return {
    ...Ledger.createBead({ role: 'polecat', task_type: 'execute', model: 'test', bead_id: id }),
    bead_id: id,
    needs,
    status,
    outcome,
  };
}

describe('swarmStatus', () => {
  it('counts beads by status', () => {
    const beads = [
      bead('a', [], 'pending'),
      bead('b', [], 'in_progress'),
      bead('c', [], 'done', 'SUCCESS'),
      bead('d', [], 'failed', 'FAILURE'),
    ];

    const status = swarmStatus(beads);
    expect(status.total).toBe(4);
    expect(status.pending).toBe(1);
    expect(status.in_progress).toBe(1);
    expect(status.done).toBe(1);
    expect(status.failed).toBe(1);
  });

  it('identifies blocked beads (unmet prerequisites)', () => {
    const beads = [
      bead('root', [], 'pending'),
      bead('dep', ['root'], 'pending'),   // blocked by 'root'
    ];

    const status = swarmStatus(beads);
    expect(status.blocked).toContain('dep');
    expect(status.blocked).not.toContain('root');
  });

  it('does not mark completed beads as blocked', () => {
    const beads = [
      bead('a', [], 'done', 'SUCCESS'),
      bead('b', ['a'], 'pending'),  // a is done, so b is NOT blocked
    ];

    const status = swarmStatus(beads);
    expect(status.blocked).not.toContain('b');
  });
});

describe('swarmResetBead', () => {
  it('resets a failed bead to pending', () => {
    const failed = bead('x', [], 'failed', 'FAILURE');
    const reset = swarmResetBead(failed);

    expect(reset.status).toBe('pending');
    expect(reset.outcome).toBeUndefined();
    expect(reset.bead_id).toBe('x');
  });
});

describe('swarmAbortWorkflow', () => {
  it('aborts root bead and all downstream dependents', () => {
    const beads = [
      bead('root', []),
      bead('child1', ['root']),
      bead('child2', ['root']),
      bead('grandchild', ['child1']),
      bead('unrelated', []),
    ];

    const aborted = swarmAbortWorkflow('root', beads);
    const abortedIds = aborted.map((b) => b.bead_id);

    expect(abortedIds).toContain('root');
    expect(abortedIds).toContain('child1');
    expect(abortedIds).toContain('child2');
    expect(abortedIds).toContain('grandchild');
    expect(abortedIds).not.toContain('unrelated');

    // All aborted beads should have FAILURE outcome
    expect(aborted.every((b) => b.status === 'failed' && b.outcome === 'FAILURE')).toBe(true);
  });
});

describe('findForkGroups', () => {
  it('identifies fork groups (parallel beads from same parent)', () => {
    const beads = [
      bead('parent', []),
      bead('fork1', ['parent']),
      bead('fork2', ['parent']),
      bead('fork3', ['parent']),
      bead('solo', ['other']),
    ];

    const groups = findForkGroups(beads);
    expect(groups.size).toBe(1); // One fork group with parent as dependency

    const forkGroup = [...groups.values()][0];
    const ids = forkGroup.map((b) => b.bead_id);
    expect(ids).toContain('fork1');
    expect(ids).toContain('fork2');
    expect(ids).toContain('fork3');
  });
});

describe('isRendezvousNode', () => {
  it('identifies rendezvous nodes (multiple prerequisites)', () => {
    const join = bead('join', ['fork1', 'fork2', 'fork3']);
    const simple = bead('simple', ['parent']);
    const root = bead('root', []);

    expect(isRendezvousNode(join)).toBe(true);
    expect(isRendezvousNode(simple)).toBe(false);
    expect(isRendezvousNode(root)).toBe(false);
  });
});

describe('swarmRebalanceLimits (adaptive backpressure)', () => {
  it('expands limits when throughput is high and error rate is low', () => {
    const result = swarmRebalanceLimits(DEFAULT_IN_FLIGHT_LIMITS, {
      beadsPerMinute: 15,
      errorRate: 0.02,
    });

    // 50 * 1.5 = 75; 20 * 1.5 = 30
    expect(result.maxPolecatBeads).toBe(75);
    expect(result.maxWitnessBeads).toBe(30);
  });

  it('restores defaults when error rate is too high', () => {
    const expanded = { maxPolecatBeads: 75, maxWitnessBeads: 30 };
    const result = swarmRebalanceLimits(expanded, {
      beadsPerMinute: 20,
      errorRate: 0.10,  // >= 5%
    });

    expect(result.maxPolecatBeads).toBe(DEFAULT_IN_FLIGHT_LIMITS.maxPolecatBeads);
    expect(result.maxWitnessBeads).toBe(DEFAULT_IN_FLIGHT_LIMITS.maxWitnessBeads);
  });

  it('restores defaults when throughput is too low', () => {
    const expanded = { maxPolecatBeads: 75, maxWitnessBeads: 30 };
    const result = swarmRebalanceLimits(expanded, {
      beadsPerMinute: 5,  // < 10
      errorRate: 0.01,
    });

    expect(result.maxPolecatBeads).toBe(DEFAULT_IN_FLIGHT_LIMITS.maxPolecatBeads);
    expect(result.maxWitnessBeads).toBe(DEFAULT_IN_FLIGHT_LIMITS.maxWitnessBeads);
  });

  it('caps expansion at MAX_LIMITS (100 polecat, 40 witness)', () => {
    const alreadyHigh = { maxPolecatBeads: 90, maxWitnessBeads: 38 };
    const result = swarmRebalanceLimits(alreadyHigh, {
      beadsPerMinute: 50,
      errorRate: 0.01,
    });

    expect(result.maxPolecatBeads).toBe(100);  // 90 * 1.5 = 135 → capped at 100
    expect(result.maxWitnessBeads).toBe(40);    // 38 * 1.5 = 57 → capped at 40
  });

  it('defaults are within expected ranges', () => {
    expect(DEFAULT_IN_FLIGHT_LIMITS.maxPolecatBeads).toBe(50);
    expect(DEFAULT_IN_FLIGHT_LIMITS.maxWitnessBeads).toBe(20);
  });
});

describe('Gate 7: 10-bead swarm with parallel and sequential stages', () => {
  it('sorts a realistic 10-bead swarm correctly', async () => {
    const { SwarmCoordinator } = await import('../../src/swarm/coordinator');
    const coordinator = new SwarmCoordinator();

    // Stage 1: setup (parallel)
    const b1 = bead('setup-1', []);
    const b2 = bead('setup-2', []);
    const b3 = bead('setup-3', []);

    // Stage 2: build (depends on setup)
    const b4 = bead('build-1', ['setup-1', 'setup-2'], 'pending');
    const b5 = bead('build-2', ['setup-3'], 'pending');

    // Stage 3: test (depends on build)
    const b6 = bead('test-1', ['build-1'], 'pending');
    const b7 = bead('test-2', ['build-1'], 'pending');
    const b8 = bead('test-3', ['build-2'], 'pending');

    // Stage 4: integrate (join all tests)
    const b9 = bead('integrate', ['test-1', 'test-2', 'test-3'], 'pending');

    // Stage 5: deploy (depends on integrate)
    const b10 = bead('deploy', ['integrate'], 'pending');

    const all = [b1, b2, b3, b4, b5, b6, b7, b8, b9, b10];

    // Should not throw (no cycles)
    const sorted = coordinator.topologicalSort(all);
    expect(sorted.length).toBe(10);

    // All setup beads should come before build beads
    const setupIdx = Math.max(
      sorted.findIndex((b) => b.bead_id === 'setup-1'),
      sorted.findIndex((b) => b.bead_id === 'setup-2'),
      sorted.findIndex((b) => b.bead_id === 'setup-3'),
    );
    const buildIdx = Math.min(
      sorted.findIndex((b) => b.bead_id === 'build-1'),
      sorted.findIndex((b) => b.bead_id === 'build-2'),
    );
    expect(setupIdx).toBeLessThan(buildIdx);

    // Deploy should be last
    expect(sorted[sorted.length - 1].bead_id).toBe('deploy');

    // No cycles
    const cycles = coordinator.detectCycles(all);
    expect(cycles).toHaveLength(0);
  });
});

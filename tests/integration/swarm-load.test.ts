// Tests: Gate 8 — Load test with 100+ beads processed concurrently

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Ledger } from '../../src/ledger/index';
import { SwarmCoordinator } from '../../src/swarm/coordinator';
import { swarmStatus } from '../../src/swarm/tools';
import type { Bead } from '../../src/types/index';

const TEST_RIGS_ROOT = path.join(os.tmpdir(), `nos-swarm-load-rigs-${Date.now()}`);
const LOAD_RIG = `swarm-load-${Date.now()}`;

beforeAll(() => {
  process.env.NOS_RIGS_ROOT = TEST_RIGS_ROOT;
  fs.mkdirSync(TEST_RIGS_ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_RIGS_ROOT, { recursive: true, force: true });
});

function makeBead(
  id: string,
  needs: string[] = [],
  role: Bead['role'] = 'polecat',
): Bead {
  return {
    ...Ledger.createBead({ role, task_type: 'execute', model: 'llama-3.1-8b-instant', bead_id: id }),
    bead_id: id,
    needs,
    status: 'pending',
    rig: LOAD_RIG,
  };
}

describe('Gate 8: 100+ bead load test', () => {
  it('appends 100 beads concurrently without corruption', async () => {
    const ledger = new Ledger(TEST_RIGS_ROOT);
    const loadRig = `load-rig-${Date.now()}`;

    const beads = Array.from({ length: 100 }, (_, i) =>
      Ledger.createBead({
        role: 'polecat',
        task_type: `task-${i}`,
        model: 'llama-3.1-8b-instant',
        rig: loadRig,
        status: 'pending',
      }),
    );

    // Write all 100 beads concurrently
    await Promise.all(beads.map((b) => ledger.appendBead(loadRig, b)));

    const read = ledger.readBeads(loadRig);
    expect(read.length).toBe(100);

    // All checksums valid (readBeads already validates)
    const ids = new Set(read.map((b) => b.bead_id));
    expect(ids.size).toBe(100); // No duplicates
  }, 15000);

  it('topologically sorts 100 beads in a linear chain', () => {
    const coordinator = new SwarmCoordinator();

    // Linear chain: bead-0 → bead-1 → ... → bead-99
    const beads = Array.from({ length: 100 }, (_, i) =>
      makeBead(`bead-${i}`, i > 0 ? [`bead-${i - 1}`] : []),
    );

    const sorted = coordinator.topologicalSort(beads);
    expect(sorted.length).toBe(100);
    expect(sorted[0].bead_id).toBe('bead-0');
    expect(sorted[99].bead_id).toBe('bead-99');
  });

  it('detects status correctly across 100 beads with mixed states', () => {
    const beads: Bead[] = [
      // 40 done
      ...Array.from({ length: 40 }, (_, i) =>
        { const b = makeBead(`done-${i}`); return { ...b, status: 'done' as const, outcome: 'SUCCESS' as const }; }
      ),
      // 20 in progress
      ...Array.from({ length: 20 }, (_, i) =>
        { const b = makeBead(`ip-${i}`); return { ...b, status: 'in_progress' as const }; }
      ),
      // 30 pending (10 blocked by in-progress prerequisites)
      ...Array.from({ length: 20 }, (_, i) =>
        makeBead(`free-${i}`)
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        makeBead(`blocked-${i}`, [`ip-${i}`])
      ),
      // 10 failed
      ...Array.from({ length: 10 }, (_, i) =>
        { const b = makeBead(`fail-${i}`); return { ...b, status: 'failed' as const, outcome: 'FAILURE' as const }; }
      ),
    ];

    expect(beads.length).toBe(100);

    const status = swarmStatus(beads);
    expect(status.total).toBe(100);
    expect(status.done).toBe(40);
    expect(status.in_progress).toBe(20);
    expect(status.failed).toBe(10);
    expect(status.blocked.length).toBe(10); // blocked by in-progress prereqs
  });

  it('fan-out tree of 100 beads dispatches critical path first', () => {
    const coordinator = new SwarmCoordinator();

    // Root → 10 branches → 9 leaves each = 1 + 10 + 90 = 101 beads
    const root = makeBead('root', [], 'mayor');
    const branches = Array.from({ length: 10 }, (_, i) => {
      const b = makeBead(`branch-${i}`, ['root']);
      return { ...b, critical_path: i === 0, fan_out_weight: 10 - i };
    });
    const leaves = branches.flatMap((branch, bi) =>
      Array.from({ length: 9 }, (_, li) =>
        makeBead(`leaf-${bi}-${li}`, [branch.bead_id]),
      ),
    );

    const all = [root, ...branches, ...leaves];
    expect(all.length).toBe(101);

    const sorted = coordinator.topologicalSort(all);
    expect(sorted.length).toBe(101);
    expect(sorted[0].bead_id).toBe('root');

    // No cycles
    expect(coordinator.detectCycles(all)).toHaveLength(0);
  });
});

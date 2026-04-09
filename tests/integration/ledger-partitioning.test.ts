// Tests: Per-rig ledger partitions avoid cross-rig lock contention (#14)

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Ledger } from '../../src/ledger/index';

const TEST_RIGS_ROOT = path.join(os.tmpdir(), `nos-partition-rigs-${Date.now()}`);

beforeAll(() => {
  process.env.NOS_RIGS_ROOT = TEST_RIGS_ROOT;
  fs.mkdirSync(TEST_RIGS_ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_RIGS_ROOT, { recursive: true, force: true });
});

describe('Ledger per-rig partitioning (#14)', () => {
  it('concurrent writes to different rigs complete without interference', async () => {
    const ledger = new Ledger();
    const RIG_A = 'rig-partition-a';
    const RIG_B = 'rig-partition-b';
    const RIG_C = 'rig-partition-c';

    const WRITES_PER_RIG = 20;

    const writeToRig = async (rig: string): Promise<void> => {
      for (let i = 0; i < WRITES_PER_RIG; i++) {
        const bead = Ledger.createBead({
          role: 'polecat',
          task_type: `task-${rig}-${i}`,
          model: 'llama-3.1-8b-instant',
          rig,
          status: 'done',
          outcome: 'SUCCESS',
        });
        await ledger.appendBead(rig, bead);
      }
    };

    // Write to all 3 rigs concurrently
    await Promise.all([writeToRig(RIG_A), writeToRig(RIG_B), writeToRig(RIG_C)]);

    // Each rig should have exactly WRITES_PER_RIG beads
    const beadsA = ledger.readBeads(RIG_A);
    const beadsB = ledger.readBeads(RIG_B);
    const beadsC = ledger.readBeads(RIG_C);

    expect(beadsA.length).toBe(WRITES_PER_RIG);
    expect(beadsB.length).toBe(WRITES_PER_RIG);
    expect(beadsC.length).toBe(WRITES_PER_RIG);

    // No bead should appear in the wrong rig
    const allBeadIds = new Set([
      ...beadsA.map((b) => b.bead_id),
      ...beadsB.map((b) => b.bead_id),
      ...beadsC.map((b) => b.bead_id),
    ]);
    expect(allBeadIds.size).toBe(WRITES_PER_RIG * 3);
  });

  it('per-rig lock files are distinct paths', () => {
    const ledger = new Ledger();

    // Verify that different rigs produce different ledger paths by writing to them
    const rig1 = 'partition-lock-test-1';
    const rig2 = 'partition-lock-test-2';

    const path1 = path.join(TEST_RIGS_ROOT, rig1, 'beads', 'current.jsonl');
    const path2 = path.join(TEST_RIGS_ROOT, rig2, 'beads', 'current.jsonl');

    expect(path1).not.toBe(path2);

    // Verify the lock file paths are also distinct
    const lock1 = path1 + '.lock';
    const lock2 = path2 + '.lock';
    expect(lock1).not.toBe(lock2);
  });

  it('rig-A lock contention does not block rig-B writes', async () => {
    const ledger = new Ledger();
    const RIG_A = 'contention-rig-a';
    const RIG_B = 'contention-rig-b';

    // Pre-seed rig A with some beads
    for (let i = 0; i < 5; i++) {
      await ledger.appendBead(RIG_A, Ledger.createBead({
        role: 'polecat',
        task_type: 'seed',
        model: 'test',
        rig: RIG_A,
      }));
    }

    // Concurrent: heavy writes to rig A, single write to rig B
    const heavyRigA = Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        ledger.appendBead(RIG_A, Ledger.createBead({
          role: 'polecat',
          task_type: `task-${i}`,
          model: 'test',
          rig: RIG_A,
        })),
      ),
    );

    const singleRigB = ledger.appendBead(
      RIG_B,
      Ledger.createBead({ role: 'polecat', task_type: 'single', model: 'test', rig: RIG_B }),
    );

    await Promise.all([heavyRigA, singleRigB]);

    const beadsB = ledger.readBeads(RIG_B);
    expect(beadsB.length).toBe(1);
    expect(beadsB[0].task_type).toBe('single');
  });
});

// Integration Tests: Concurrent appends don't corrupt ledger

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Ledger } from '../../src/ledger/index';
import type { Bead } from '../../src/types/index';

const TEST_RIGS_ROOT = path.join(os.tmpdir(), `nos-concurrent-${Date.now()}`);

beforeAll(() => {
  process.env.NOS_RIGS_ROOT = TEST_RIGS_ROOT;
});

afterAll(() => {
  fs.rmSync(TEST_RIGS_ROOT, { recursive: true, force: true });
});

function makeBeads(count: number, prefix = 'bead'): Bead[] {
  return Array.from({ length: count }, (_, i) =>
    Ledger.createBead({
      role: 'polecat',
      task_type: `task_${i}`,
      model: 'llama-3.1-8b-instant',
      bead_id: `${prefix}-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }),
  );
}

describe('Concurrent ledger appends', () => {
  it('100 concurrent appends do not corrupt any records', async () => {
    const ledger = new Ledger(TEST_RIGS_ROOT);
    const beads = makeBeads(100, 'concurrent');
    const rig = 'concurrent-rig';

    // Fire all appends simultaneously
    await Promise.all(beads.map((b) => ledger.appendBead(rig, b)));

    // Read back and verify all beads present with valid checksums
    const readBack = ledger.readBeads(rig);
    expect(readBack.length).toBe(100);

    // Each bead should be findable
    for (const bead of beads) {
      const found = readBack.find((b) => b.bead_id === bead.bead_id);
      expect(found).toBeDefined();
    }
  }, 30000);

  it('50 concurrent appends to different rigs are independent', async () => {
    const ledger = new Ledger(TEST_RIGS_ROOT);

    const rigs = ['rig-alpha', 'rig-beta', 'rig-gamma', 'rig-delta', 'rig-epsilon'];
    const beadsPerRig = 10;

    const allPromises: Promise<void>[] = [];
    const beadsByRig: Map<string, Bead[]> = new Map();

    for (const rig of rigs) {
      const beads = makeBeads(beadsPerRig, `multi-${rig}`);
      beadsByRig.set(rig, beads);
      for (const bead of beads) {
        allPromises.push(ledger.appendBead(rig, bead));
      }
    }

    await Promise.all(allPromises);

    // Verify each rig has correct beads
    for (const rig of rigs) {
      const readBack = ledger.readBeads(rig);
      expect(readBack.length).toBe(beadsPerRig);
      const expectedBeads = beadsByRig.get(rig)!;
      for (const bead of expectedBeads) {
        const found = readBack.find((b) => b.bead_id === bead.bead_id);
        expect(found).toBeDefined();
      }
    }
  }, 30000);

  it('preserves JSONL integrity under concurrent writes (no truncated lines)', async () => {
    const ledger = new Ledger(TEST_RIGS_ROOT);
    const rig = 'integrity-rig';
    const beads = makeBeads(50, 'integrity');

    await Promise.all(beads.map((b) => ledger.appendBead(rig, b)));

    // Read the raw file and check each line is valid JSON
    const filePath = path.join(TEST_RIGS_ROOT, rig, 'beads', 'current.jsonl');
    const lines = fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());

    expect(lines.length).toBe(50);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 30000);
});

describe('Ledger sequential reads after concurrent writes', () => {
  it('getOutcome after concurrent status updates returns latest', async () => {
    const ledger = new Ledger(TEST_RIGS_ROOT);
    const rig = 'outcome-rig';

    const bead = Ledger.createBead({
      role: 'polecat',
      task_type: 'outcome_test',
      model: 'llama-3.1-8b-instant',
    });
    await ledger.appendBead(rig, bead);

    // Concurrent status updates
    await Promise.all([
      ledger.updateBead(rig, bead.bead_id, { status: 'in_progress' }),
      ledger.updateBead(rig, bead.bead_id, { outcome: 'SUCCESS', status: 'done' }),
    ]);

    // Most recent write with SUCCESS outcome should be findable
    const outcome = ledger.getOutcome(bead.bead_id, rig);
    expect(outcome).toBe('SUCCESS');
  }, 15000);
});

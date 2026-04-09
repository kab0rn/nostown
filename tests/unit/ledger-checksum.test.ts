// Tests: Checksum validation, corrupt bead rejected

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Ledger, computeChecksum, validateChecksum } from '../../src/ledger/index';
import type { Bead } from '../../src/types/index';

const TEST_RIGS_ROOT = path.join(os.tmpdir(), `nos-ledger-test-${Date.now()}`);

beforeAll(() => {
  process.env.NOS_RIGS_ROOT = TEST_RIGS_ROOT;
});

afterAll(() => {
  fs.rmSync(TEST_RIGS_ROOT, { recursive: true, force: true });
});

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return Ledger.createBead({
    role: 'polecat',
    task_type: 'execute',
    model: 'llama-3.1-8b-instant',
    ...overrides,
  });
}

describe('Checksum computation', () => {
  it('computes a deterministic sha256 checksum', () => {
    const bead = makeBead();
    const cs1 = computeChecksum(bead);
    const cs2 = computeChecksum(bead);
    expect(cs1).toBe(cs2);
    expect(cs1).toHaveLength(64); // 64 hex chars = 32 bytes
  });

  it('changes checksum when bead content changes', () => {
    const bead1 = makeBead({ task_type: 'execute' });
    const bead2 = { ...bead1, task_type: 'review' };
    expect(computeChecksum(bead1)).not.toBe(computeChecksum(bead2));
  });

  it('ignores the checksum field itself when computing', () => {
    const bead = makeBead();
    const cs1 = computeChecksum(bead);
    const beadWithOldChecksum = { ...bead, checksum: 'old-value' };
    expect(computeChecksum(beadWithOldChecksum)).toBe(cs1);
  });
});

describe('Checksum validation', () => {
  it('validates a correctly checksummed bead', () => {
    const bead = makeBead();
    const checksummed = { ...bead, checksum: computeChecksum(bead) };
    expect(validateChecksum(checksummed)).toBe(true);
  });

  it('rejects bead with wrong checksum', () => {
    const bead = makeBead();
    const corrupted = { ...bead, checksum: 'deadbeef' };
    expect(validateChecksum(corrupted)).toBe(false);
  });

  it('rejects bead with no checksum', () => {
    const bead = makeBead();
    expect(validateChecksum(bead)).toBe(false);
  });
});

describe('Ledger append and read', () => {
  const ledger = new Ledger(TEST_RIGS_ROOT);

  it('appends a bead and reads it back', async () => {
    const bead = makeBead({ task_type: 'test_append' });
    await ledger.appendBead('test-rig', bead);

    const beads = ledger.readBeads('test-rig');
    const found = beads.find((b) => b.bead_id === bead.bead_id);
    expect(found).toBeDefined();
    expect(found?.task_type).toBe('test_append');
  });

  it('rejects bead with invalid checksum on read', async () => {
    const filePath = path.join(TEST_RIGS_ROOT, 'corrupt-rig', 'beads', 'current.jsonl');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const bead = makeBead({ task_type: 'corrupt_test' });
    const corruptBead = { ...bead, checksum: 'bad-checksum' };
    fs.writeFileSync(filePath, JSON.stringify(corruptBead) + '\n', 'utf8');

    const corruptLedger = new Ledger(TEST_RIGS_ROOT);
    const beads = corruptLedger.readBeads('corrupt-rig');
    // Corrupt bead should be filtered out
    expect(beads.find((b) => b.bead_id === bead.bead_id)).toBeUndefined();
  });

  it('validates bead has required fields', async () => {
    const invalidBead = { bead_id: '' } as unknown as Bead;
    await expect(ledger.appendBead('test-rig', invalidBead)).rejects.toThrow(/bead_id/);
  });

  it('getBead finds bead by ID', async () => {
    const bead = makeBead({ task_type: 'get_test' });
    await ledger.appendBead('find-rig', bead);

    const found = ledger.getBead(bead.bead_id, 'find-rig');
    expect(found?.bead_id).toBe(bead.bead_id);
  });

  it('getOutcome returns SUCCESS after update', async () => {
    const bead = makeBead({ task_type: 'outcome_test' });
    await ledger.appendBead('outcome-rig', bead);
    await ledger.updateBead('outcome-rig', bead.bead_id, { outcome: 'SUCCESS', status: 'done' });

    const outcome = ledger.getOutcome(bead.bead_id, 'outcome-rig');
    expect(outcome).toBe('SUCCESS');
  });
});

// Tests: Mayor checkpoints plan before dispatch (#8)
// Tests that orchestrate() saves a MemPalace checkpoint and attaches checkpoint_id to all beads

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Mayor } from '../../src/roles/mayor';
import { MemPalaceClient } from '../../src/mempalace/client';
import { GroqProvider } from '../../src/groq/provider';
import { generateKeyPair } from '../../src/convoys/sign';

const TEST_KEY_DIR = path.join(os.tmpdir(), `nos-ckpt-keys-${Date.now()}`);
const TEST_RIGS_ROOT = path.join(os.tmpdir(), `nos-ckpt-rigs-${Date.now()}`);
const TEST_DB = path.join(os.tmpdir(), `nos-ckpt-kg-${Date.now()}.sqlite`);

beforeAll(async () => {
  process.env.NOS_ROLE_KEY_DIR = TEST_KEY_DIR;
  process.env.NOS_RIGS_ROOT = TEST_RIGS_ROOT;
  fs.mkdirSync(TEST_KEY_DIR, { recursive: true });
  fs.mkdirSync(TEST_RIGS_ROOT, { recursive: true });
  await generateKeyPair('mayor_ckpt');
});

afterAll(() => {
  fs.rmSync(TEST_KEY_DIR, { recursive: true, force: true });
  fs.rmSync(TEST_RIGS_ROOT, { recursive: true, force: true });
  fs.rmSync(TEST_DB, { force: true });
  jest.restoreAllMocks();
});

const FAKE_DECOMPOSE_RESULT = JSON.stringify({
  beads: [
    {
      task_type: 'execute',
      task_description: 'Step 1',
      role: 'polecat',
      needs: [],
      critical_path: true,
      witness_required: false,
      fan_out_weight: 1,
    },
    {
      task_type: 'execute',
      task_description: 'Step 2',
      role: 'polecat',
      needs: [],
      critical_path: false,
      witness_required: false,
      fan_out_weight: 1,
    },
  ],
});

describe('Mayor checkpoint before dispatch (#8)', () => {
  let mayor: Mayor;
  let saveCheckpointSpy: jest.SpyInstance;
  let executeSpy: jest.SpyInstance;
  let wakeupSpy: jest.SpyInstance;

  beforeEach(() => {
    mayor = new Mayor({
      agentId: 'mayor_ckpt',
      rigName: 'ckpt-rig',
      kgPath: TEST_DB,
    });

    // Mock palace to avoid network calls
    wakeupSpy = jest
      .spyOn(MemPalaceClient.prototype, 'wakeup')
      .mockRejectedValue(new Error('palace offline (non-fatal)'));

    jest
      .spyOn(MemPalaceClient.prototype, 'search')
      .mockRejectedValue(new Error('palace offline (non-fatal)'));

    saveCheckpointSpy = jest
      .spyOn(MemPalaceClient.prototype, 'saveCheckpoint')
      .mockResolvedValue('ckpt-test-abc123');

    // Mock Groq to return valid bead decomposition
    executeSpy = jest
      .spyOn(GroqProvider.prototype, 'executeInference')
      .mockResolvedValue(FAKE_DECOMPOSE_RESULT);
  });

  afterEach(() => {
    mayor.close();
    jest.restoreAllMocks();
  });

  it('calls saveCheckpoint before returning dispatch plan', async () => {
    const plan = await mayor.orchestrate({
      description: 'Test task for checkpoint validation',
    });

    expect(saveCheckpointSpy).toHaveBeenCalledTimes(1);
    expect(plan.checkpoint_id).toBe('ckpt-test-abc123');
  });

  it('all returned beads carry the plan_checkpoint_id', async () => {
    const plan = await mayor.orchestrate({
      description: 'Multi-bead checkpoint test',
    });

    expect(plan.beads.length).toBeGreaterThan(0);
    for (const bead of plan.beads) {
      expect(bead.plan_checkpoint_id).toBe('ckpt-test-abc123');
    }
  });

  it('blocks orchestrate if checkpoint save fails', async () => {
    saveCheckpointSpy.mockRejectedValue(new Error('palace DB unavailable'));

    await expect(
      mayor.orchestrate({ description: 'Will fail at checkpoint' }),
    ).rejects.toThrow(/checkpoint failed/);
  });

  it('saveCheckpoint is called with agentId and bead IDs', async () => {
    const plan = await mayor.orchestrate({ description: 'Checkpoint args test' });

    expect(saveCheckpointSpy).toHaveBeenCalledWith(
      'mayor_ckpt',
      expect.objectContaining({
        task: expect.any(Object),
        beads: expect.any(Array),
      }),
      expect.arrayContaining([expect.any(String)]),
    );

    // Bead count in the checkpoint matches returned beads
    const callArgs = saveCheckpointSpy.mock.calls[0] as [string, unknown, string[]];
    expect(callArgs[2].length).toBe(plan.beads.length);
  });

  it('throws WAITING_FOR_CAPACITY when in-flight limit is exceeded', async () => {
    // Pass a very small limit that the ledger (empty) won't hit,
    // but we can force it by setting limit to 0.
    await expect(
      mayor.orchestrate(
        { description: 'Should be blocked' },
        { maxPolecatBeads: 0, maxWitnessBeads: 20 },
      ),
    ).rejects.toThrow(/WAITING_FOR_CAPACITY/);
  });

  it('proceeds normally when in-flight count is below limit', async () => {
    const plan = await mayor.orchestrate(
      { description: 'Should proceed' },
      { maxPolecatBeads: 50, maxWitnessBeads: 20 },
    );
    expect(plan.beads.length).toBeGreaterThan(0);
  });
});

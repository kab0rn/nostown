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

  it('throws WAITING_FOR_CAPACITY when inbox depth >= 50 (CONVOYS.md §Backpressure)', async () => {
    const { ConvoyBus } = await import('../../src/convoys/bus');
    // Simulate polecat inbox at 50 unread convoys
    jest.spyOn(ConvoyBus.prototype, 'inboxCount').mockImplementation((role: string) => {
      return role === 'polecat' ? 50 : 0;
    });

    await expect(
      mayor.orchestrate({ description: 'Should be inbox-blocked' }),
    ).rejects.toThrow(/WAITING_FOR_CAPACITY.*polecat.*50/);

    jest.restoreAllMocks();
  });
});

describe('Mayor outage queue (RESILIENCE.md §Convoy Queueing)', () => {
  let mayor: Mayor;

  beforeEach(() => {
    mayor = new Mayor({
      agentId: 'mayor_ckpt',
      rigName: 'outage-rig',
      kgPath: TEST_DB,
    });
  });

  afterEach(() => {
    mayor.close();
  });

  it('outage queue starts empty', () => {
    expect(mayor.outageQueueDepth).toBe(0);
  });

  it('setOutageActive(true) causes dispatchBead to queue rather than send', async () => {
    const { ConvoyBus } = await import('../../src/convoys/bus');
    const bus = new ConvoyBus('outage-rig');
    const { Ledger: LedgerCls } = await import('../../src/ledger/index');

    const bead = LedgerCls.createBead({
      role: 'polecat',
      task_type: 'execute',
      model: 'test',
      rig: 'outage-rig',
      status: 'pending',
      plan_checkpoint_id: 'ckpt-outage-123',
    });

    mayor.setOutageActive(true);
    await mayor.dispatchBead(bead, bus, 1);

    // Should not have written to the bus mailbox
    const inbox = bus.readInbox('polecat');
    expect(inbox.length).toBe(0);

    // But outage queue should have 1 item
    expect(mayor.outageQueueDepth).toBe(1);
  });

  it('drainOutageQueue dispatches all queued beads when outage clears', async () => {
    const { ConvoyBus } = await import('../../src/convoys/bus');
    const bus = new ConvoyBus('drain-rig');
    const { Ledger: LedgerCls } = await import('../../src/ledger/index');

    const bead1 = LedgerCls.createBead({ role: 'polecat', task_type: 'execute', model: 'test', rig: 'drain-rig', status: 'pending', plan_checkpoint_id: 'ckpt-drain-1', bead_id: 'drain-bead-001' });
    const bead2 = LedgerCls.createBead({ role: 'polecat', task_type: 'execute', model: 'test', rig: 'drain-rig', status: 'pending', plan_checkpoint_id: 'ckpt-drain-2', bead_id: 'drain-bead-002' });

    mayor.setOutageActive(true);
    await mayor.dispatchBead(bead1, bus, 1);
    await mayor.dispatchBead(bead2, bus, 2);
    expect(mayor.outageQueueDepth).toBe(2);

    // Now clear outage and drain
    mayor.setOutageActive(false);
    const dispatched = await mayor.drainOutageQueue(bus, 3);

    expect(dispatched).toBe(2);
    expect(mayor.outageQueueDepth).toBe(0);

    // Both beads should now be in the inbox
    const inbox = bus.readInbox('polecat');
    const ids = inbox.map((c) => c.payload.data['bead_id'] as string);
    expect(ids).toContain('drain-bead-001');
    expect(ids).toContain('drain-bead-002');
  });

  it('drainOutageQueue returns 0 when queue is empty', async () => {
    const { ConvoyBus } = await import('../../src/convoys/bus');
    const bus = new ConvoyBus('empty-drain-rig');
    const count = await mayor.drainOutageQueue(bus, 1);
    expect(count).toBe(0);
  });
});

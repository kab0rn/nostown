// Tests: Mayor generates a local checkpoint ID before dispatch (#8)
// Tests that orchestrate() produces a checkpoint_id and attaches it to all beads.
// Checkpoints are ephemeral local UUIDs (ckpt_<12hex>), not persisted to the KG.

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Mayor } from '../../src/roles/mayor';
import { GroqProvider } from '../../src/groq/provider';
import { generateKeyPair } from '../../src/convoys/sign';

const TEST_KEY_DIR = path.join(os.tmpdir(), `nos-ckpt-keys-${Date.now()}`);
const TEST_RIGS_ROOT = path.join(os.tmpdir(), `nos-ckpt-rigs-${Date.now()}`);
const TEST_DB = path.join(os.tmpdir(), `nos-ckpt-kg-${Date.now()}.sqlite`);

beforeAll(async () => {
  process.env.NOS_ROLE_KEY_DIR = TEST_KEY_DIR;
  process.env.NOS_RIGS_ROOT = TEST_RIGS_ROOT;
  process.env.NOS_KG_PATH = TEST_DB;
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
  let executeSpy: jest.SpyInstance;

  beforeEach(() => {
    mayor = new Mayor({
      agentId: 'mayor_ckpt',
      rigName: 'ckpt-rig',
      kgPath: TEST_DB,
    });

    // Mock Groq to return valid bead decomposition
    executeSpy = jest
      .spyOn(GroqProvider.prototype, 'executeInference')
      .mockResolvedValue(FAKE_DECOMPOSE_RESULT);
  });

  afterEach(() => {
    mayor.close();
    jest.restoreAllMocks();
  });

  it('orchestrate() returns a checkpoint_id matching ckpt_ pattern', async () => {
    const plan = await mayor.orchestrate({
      description: 'Test task for checkpoint validation',
    });

    expect(plan.checkpoint_id).toMatch(/^ckpt_[a-f0-9-]{12}$/);
  });

  it('all returned beads carry the plan_checkpoint_id', async () => {
    const plan = await mayor.orchestrate({
      description: 'Multi-bead checkpoint test',
    });

    expect(plan.beads.length).toBeGreaterThan(0);
    for (const bead of plan.beads) {
      expect(bead.plan_checkpoint_id).toBe(plan.checkpoint_id);
    }
  });

  it('throws WAITING_FOR_CAPACITY when in-flight limit is exceeded', async () => {
    // Use a dedicated rig for this test to avoid polluting the shared ckpt-rig ledger.
    // Dynamic rebalance restores defaults for 0 bpm, so we must exceed DEFAULT (50).
    const capMayor = new Mayor({ agentId: 'mayor_ckpt', rigName: 'cap-rig', kgPath: TEST_DB });
    const { Ledger: LedgerCls } = await import('../../src/ledger/index');
    const ledger = new LedgerCls(TEST_RIGS_ROOT);
    for (let i = 0; i < 51; i++) {
      await ledger.appendBead('cap-rig', LedgerCls.createBead({
        role: 'polecat',
        task_type: 'execute',
        model: 'test',
        rig: 'cap-rig',
        status: 'in_progress',
        plan_checkpoint_id: 'ckpt-cap-test',
        bead_id: `cap-bead-${i.toString().padStart(3, '0')}`,
      }));
    }

    await expect(
      capMayor.orchestrate({ description: 'Should be blocked' }),
    ).rejects.toThrow(/WAITING_FOR_CAPACITY/);

    capMayor.close();
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

describe('Mayor CoVe self-critique pass (P8)', () => {
  let mayor: Mayor;

  beforeEach(() => {
    mayor = new Mayor({
      agentId: 'mayor_ckpt',
      rigName: 'cove-rig',
      kgPath: TEST_DB,
    });
  });

  afterEach(() => {
    mayor.close();
    jest.restoreAllMocks();
  });

  it('CoVe adds a missing dependency edge when second call returns a correction', async () => {
    // First call (decompose): two beads, B does NOT list A as a need
    const decomposeResult = JSON.stringify({
      beads: [
        { task_type: 'setup', task_description: 'Step A', role: 'polecat', needs: [], critical_path: false, witness_required: false, fan_out_weight: 1 },
        { task_type: 'deploy', task_description: 'Step B (should need A)', role: 'polecat', needs: [], critical_path: false, witness_required: false, fan_out_weight: 1 },
      ],
    });

    jest.spyOn(GroqProvider.prototype, 'executeInference')
      .mockImplementation(async (params) => {
        if (params.task_type === 'decompose') {
          return decomposeResult;
        }
        // CoVe call: extract bead IDs from the plan JSON embedded in user message
        const userContent = params.messages.find((m) => m.role === 'user')?.content ?? '';
        const ids = [...userContent.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
        // Add a missing edge: bead[1] should depend on bead[0]
        return JSON.stringify({
          corrections: [{ bead_id: ids[1], add_needs: [ids[0]] }],
        });
      });

    const plan = await mayor.orchestrate({ description: 'Two-step deploy task' });
    expect(plan.beads).toHaveLength(2);

    // bead[1] should now have bead[0] in its needs list
    const beadA = plan.beads[0];
    const beadB = plan.beads[1];
    expect(beadB.needs).toContain(beadA.bead_id);
  });

  it('CoVe failure is non-fatal — original plan is returned', async () => {
    jest.spyOn(GroqProvider.prototype, 'executeInference')
      .mockImplementation(async (params) => {
        if (params.task_type === 'decompose') {
          return FAKE_DECOMPOSE_RESULT; // 2 beads, no needs
        }
        throw new Error('Groq rate limit');
      });

    const plan = await mayor.orchestrate({ description: 'Task where CoVe fails' });
    // Should still get the original plan intact
    expect(plan.beads).toHaveLength(2);
    for (const bead of plan.beads) {
      expect(bead.needs).toEqual([]);
    }
  });

  it('CoVe correction that introduces a cycle is discarded — original plan returned', async () => {
    // First call: bead A depends on B (A.needs = [B.id])
    // CoVe then tries to add B.needs = [A.id], creating a cycle
    let beadAId = '';
    let beadBId = '';

    jest.spyOn(GroqProvider.prototype, 'executeInference')
      .mockImplementation(async (params) => {
        if (params.task_type === 'decompose') {
          return FAKE_DECOMPOSE_RESULT; // 2 beads, both needs=[]
        }
        // CoVe call: capture both IDs and propose a mutual dependency (cycle)
        const userContent = params.messages.find((m) => m.role === 'user')?.content ?? '';
        const ids = [...userContent.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
        beadAId = ids[0];
        beadBId = ids[1];
        // A needs B AND B needs A → cycle
        return JSON.stringify({
          corrections: [
            { bead_id: beadAId, add_needs: [beadBId] },
            { bead_id: beadBId, add_needs: [beadAId] },
          ],
        });
      });

    const plan = await mayor.orchestrate({ description: 'Cycle-inducing CoVe task' });
    // Cycle should be detected and CoVe corrections discarded; original has no needs
    expect(plan.beads).toHaveLength(2);
    for (const bead of plan.beads) {
      expect(bead.needs).toEqual([]);
    }
  });
});

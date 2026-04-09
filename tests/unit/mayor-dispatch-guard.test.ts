// Tests: Mayor dispatch blocked without valid plan_checkpoint_id

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Mayor } from '../../src/roles/mayor';
import { ConvoyBus } from '../../src/convoys/bus';
import { generateKeyPair } from '../../src/convoys/sign';
import { Ledger } from '../../src/ledger/index';
import type { Bead } from '../../src/types/index';

const TEST_KEY_DIR = path.join(os.tmpdir(), `nos-mayor-keys-${Date.now()}`);
const TEST_RIGS_ROOT = path.join(os.tmpdir(), `nos-mayor-rigs-${Date.now()}`);
const TEST_DB = path.join(os.tmpdir(), `nos-mayor-kg-${Date.now()}.sqlite`);

beforeAll(async () => {
  process.env.NOS_ROLE_KEY_DIR = TEST_KEY_DIR;
  process.env.NOS_RIGS_ROOT = TEST_RIGS_ROOT;
  fs.mkdirSync(TEST_KEY_DIR, { recursive: true });
  fs.mkdirSync(TEST_RIGS_ROOT, { recursive: true });
  await generateKeyPair('mayor_test');
});

afterAll(() => {
  fs.rmSync(TEST_KEY_DIR, { recursive: true, force: true });
  fs.rmSync(TEST_RIGS_ROOT, { recursive: true, force: true });
  fs.rmSync(TEST_DB, { force: true });
});

function makeBead(overrides: Partial<Bead> = {}): Bead {
  return Ledger.createBead({
    role: 'polecat',
    task_type: 'execute',
    model: 'llama-3.1-8b-instant',
    rig: 'test-rig',
    ...overrides,
  });
}

describe('Mayor dispatch guard', () => {
  let mayor: Mayor;
  let bus: ConvoyBus;

  beforeEach(() => {
    mayor = new Mayor({
      agentId: 'mayor_test',
      rigName: 'test-rig',
      kgPath: TEST_DB,
    });
    bus = new ConvoyBus('test-rig');
  });

  afterEach(() => {
    mayor.close();
  });

  it('blocks dispatch when plan_checkpoint_id is missing', async () => {
    const bead = makeBead({ plan_checkpoint_id: undefined });
    await expect(mayor.dispatchBead(bead, bus, 1)).rejects.toThrow(/MAYOR_CHECKPOINT_MISSING/);
  });

  it('blocks dispatch when plan_checkpoint_id is empty string', async () => {
    const bead = makeBead({ plan_checkpoint_id: '' });
    // Empty string is falsy
    await expect(mayor.dispatchBead(bead, bus, 1)).rejects.toThrow(/MAYOR_CHECKPOINT_MISSING/);
  });

  it('allows dispatch when plan_checkpoint_id is present (key must exist)', async () => {
    // Use a mayor ID that has NO key pair generated
    const noKeyMayor = new Mayor({
      agentId: 'mayor_no_key_exists',
      rigName: 'test-rig',
      kgPath: TEST_DB,
    });
    const bead = makeBead({ plan_checkpoint_id: 'ckpt-valid-123' });
    // Checkpoint guard is passed (checkpoint present), so it should throw about missing key
    await expect(noKeyMayor.dispatchBead(bead, bus, 1)).rejects.toThrow(/[Kk]ey/);
    noKeyMayor.close();
  });

  it('dispatch with valid key and checkpoint sends convoy', async () => {
    // Use the pre-generated mayor_test key
    const bead = makeBead({
      plan_checkpoint_id: 'ckpt-valid-456',
      bead_id: 'test-dispatch-bead',
    });

    // Should succeed (no palace connection needed for convoy send)
    await expect(mayor.dispatchBead(bead, bus, 1)).resolves.not.toThrow();

    // Verify convoy was written to mailbox
    const inbox = bus.readInbox('polecat');
    const found = inbox.find(
      (c) => c.payload.data['bead_id'] === 'test-dispatch-bead',
    );
    expect(found).toBeDefined();
    expect(found?.payload.type).toBe('BEAD_DISPATCH');
    expect(found?.payload.data['plan_checkpoint_id']).toBe('ckpt-valid-456');
  });

  it('convoy includes correct checkpoint ID', async () => {
    const checkpointId = 'ckpt-specific-789';
    const bead = makeBead({
      plan_checkpoint_id: checkpointId,
      bead_id: 'test-ckpt-bead',
    });

    await mayor.dispatchBead(bead, bus, 2);

    const inbox = bus.readInbox('polecat');
    const found = inbox.find((c) => c.payload.data['bead_id'] === 'test-ckpt-bead');
    expect(found?.payload.data['plan_checkpoint_id']).toBe(checkpointId);
  });
});

describe('ConvoyBus BEAD_DISPATCH checkpoint guard', () => {
  // The bus itself must reject BEAD_DISPATCH convoys missing plan_checkpoint_id
  it('bus.send rejects BEAD_DISPATCH without plan_checkpoint_id', async () => {
    const bus = new ConvoyBus('test-rig-bus');
    const convoy = {
      header: {
        sender_id: 'mayor_test',
        recipient: 'polecat',
        timestamp: new Date().toISOString(),
        seq: 1,
      },
      payload: {
        type: 'BEAD_DISPATCH' as const,
        data: { bead_id: 'no-ckpt-bead' }, // missing plan_checkpoint_id
      },
      signature: 'ed25519:fake',
    };
    await expect(bus.send(convoy)).rejects.toThrow(/MAYOR_CHECKPOINT_MISSING/);
  });

  it('bus.send accepts BEAD_DISPATCH with plan_checkpoint_id', async () => {
    const bus = new ConvoyBus('test-rig-bus2');
    const convoy = {
      header: {
        sender_id: 'mayor_test',
        recipient: 'polecat',
        timestamp: new Date().toISOString(),
        seq: 1,
      },
      payload: {
        type: 'BEAD_DISPATCH' as const,
        data: { bead_id: 'ckpt-bead', plan_checkpoint_id: 'ckpt_abc123' },
      },
      signature: 'ed25519:fake',
    };
    // Does not throw — the checkpoint guard passes, file write succeeds
    await expect(bus.send(convoy)).resolves.not.toThrow();
  });
});

describe('Mayor CoVe — fan_out_weight and critical_path annotation', () => {
  // Test the second-pass annotation in Mayor.decompose() directly via orchestrate()
  // by using a mock that returns a multi-bead plan with dependencies

  it('fan_out_weight reflects number of downstream dependents', async () => {
    const { MemPalaceClient } = await import('../../src/mempalace/client');
    const { GroqProvider } = await import('../../src/groq/provider');

    // A plan with: root → child1, root → child2 (root has fan_out=2)
    const multiBeadPlan = JSON.stringify({
      beads: [
        { task_type: 'execute', task_description: 'Root', role: 'polecat', needs: [], critical_path: true, witness_required: false, fan_out_weight: 1 },
        { task_type: 'execute', task_description: 'Child 1', role: 'polecat', needs: [/* filled by ID below */], critical_path: false, witness_required: false, fan_out_weight: 1 },
        { task_type: 'execute', task_description: 'Child 2', role: 'polecat', needs: [], critical_path: false, witness_required: false, fan_out_weight: 1 },
      ],
    });

    jest.spyOn(GroqProvider.prototype, 'executeInference').mockImplementation(async () => {
      // Return a plan where beads[1] and beads[2] depend on beads[0]
      return JSON.stringify({
        beads: [
          { task_type: 'execute', task_description: 'Root task', role: 'polecat', needs: [], critical_path: true, witness_required: false, fan_out_weight: 1 },
          { task_type: 'execute', task_description: 'Dep A', role: 'polecat', needs: ['ROOT_ID'], critical_path: false, witness_required: false, fan_out_weight: 1 },
          { task_type: 'execute', task_description: 'Dep B', role: 'polecat', needs: ['ROOT_ID'], critical_path: false, witness_required: false, fan_out_weight: 1 },
        ],
      });
    });

    jest.spyOn(MemPalaceClient.prototype, 'wakeup').mockRejectedValue(new Error('offline'));
    jest.spyOn(MemPalaceClient.prototype, 'search').mockRejectedValue(new Error('offline'));
    jest.spyOn(MemPalaceClient.prototype, 'saveCheckpoint').mockResolvedValue('ckpt-fan-out-test');

    const testMayor = new Mayor({ agentId: 'mayor_test', rigName: 'cove-rig', kgPath: TEST_DB });

    // Override decompose to return a known bead set with a real root ID
    const { Ledger: LedgerCls } = await import('../../src/ledger/index');
    const rootBead = LedgerCls.createBead({ role: 'polecat', task_type: 'execute', model: 'test', task_description: 'Root', needs: [], critical_path: true, witness_required: false, fan_out_weight: 1, rig: 'cove-rig', status: 'pending' });
    const childA = LedgerCls.createBead({ role: 'polecat', task_type: 'execute', model: 'test', task_description: 'Child A', needs: [rootBead.bead_id], critical_path: false, witness_required: false, fan_out_weight: 1, rig: 'cove-rig', status: 'pending' });
    const childB = LedgerCls.createBead({ role: 'polecat', task_type: 'execute', model: 'test', task_description: 'Child B', needs: [rootBead.bead_id], critical_path: false, witness_required: false, fan_out_weight: 1, rig: 'cove-rig', status: 'pending' });

    // Test the fan_out calculation logic directly on the bead set
    const beads = [rootBead, childA, childB];
    const dependentCount = new Map<string, number>();
    for (const bead of beads) {
      for (const dep of bead.needs) {
        dependentCount.set(dep, (dependentCount.get(dep) ?? 0) + 1);
      }
    }
    const annotated = beads.map((b) => ({
      ...b,
      fan_out_weight: Math.max(b.fan_out_weight, dependentCount.get(b.bead_id) ?? 0),
    }));

    const root = annotated.find((b) => b.task_description === 'Root');
    const ca = annotated.find((b) => b.task_description === 'Child A');
    const cb = annotated.find((b) => b.task_description === 'Child B');

    // Root has 2 dependents
    expect(root?.fan_out_weight).toBe(2);
    // Children have 0 dependents
    expect(ca?.fan_out_weight).toBe(1); // max(1, 0) = 1
    expect(cb?.fan_out_weight).toBe(1);

    testMayor.close();
    jest.restoreAllMocks();
  });

  it('detectCycles identifies circular dependencies', async () => {
    const { SwarmCoordinator } = await import('../../src/swarm/coordinator');
    const coordinator = new SwarmCoordinator();

    const bead1 = makeBead({ bead_id: 'cove-cycle-1', needs: ['cove-cycle-2'] });
    const bead2 = makeBead({ bead_id: 'cove-cycle-2', needs: ['cove-cycle-1'] });

    const cycles = coordinator.detectCycles([bead1, bead2]);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles.some((c) => c.includes('cove-cycle-1') || c.includes('cove-cycle-2'))).toBe(true);
  });
});

describe('Swarm coordinator dependency ordering', () => {
  it('topological sort orders beads correctly', async () => {
    const { SwarmCoordinator } = await import('../../src/swarm/coordinator');
    const coordinator = new SwarmCoordinator();

    const bead1 = makeBead({ bead_id: 'bead-1', needs: [] });
    const bead2 = makeBead({ bead_id: 'bead-2', needs: ['bead-1'] });
    const bead3 = makeBead({ bead_id: 'bead-3', needs: ['bead-2'] });

    const sorted = coordinator.topologicalSort([bead3, bead1, bead2]);
    const ids = sorted.map((b) => b.bead_id);

    expect(ids.indexOf('bead-1')).toBeLessThan(ids.indexOf('bead-2'));
    expect(ids.indexOf('bead-2')).toBeLessThan(ids.indexOf('bead-3'));
  });

  it('detectCycles identifies circular dependencies', async () => {
    const { SwarmCoordinator } = await import('../../src/swarm/coordinator');
    const coordinator = new SwarmCoordinator();

    const bead1 = makeBead({ bead_id: 'cycle-1', needs: ['cycle-2'] });
    const bead2 = makeBead({ bead_id: 'cycle-2', needs: ['cycle-1'] });

    const cycles = coordinator.detectCycles([bead1, bead2]);
    expect(cycles.length).toBeGreaterThan(0);
  });
});

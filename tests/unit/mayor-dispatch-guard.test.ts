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

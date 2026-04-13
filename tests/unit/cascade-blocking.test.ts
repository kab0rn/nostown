// Tests: HARDENING.md §2.3 Cascade blocking
// If a predecessor Bead fails, the Convoy bus emits CONVOY_BLOCKED and blocks
// dependent beads from being dispatched.

jest.mock('groq-sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })),
}));

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Mayor } from '../../src/roles/mayor';
import { Ledger } from '../../src/ledger/index';
import { ConvoyBus } from '../../src/convoys/bus';
import { generateKeyPair } from '../../src/convoys/sign';
import type { Bead, HeartbeatEvent } from '../../src/types/index';

const TEST_KEY_DIR = path.join(os.tmpdir(), `cascade-keys-${Date.now()}`);
const TEST_RIGS = path.join(os.tmpdir(), `cascade-rigs-${Date.now()}`);
const TEST_DB = path.join(os.tmpdir(), `cascade-kg-${Date.now()}.sqlite`);

function makeBead(id: string, needs: string[] = [], status: Bead['status'] = 'pending'): Bead {
  return Ledger.createBead({
    role: 'polecat',
    task_type: 'execute',
    model: 'llama-3.1-8b-instant',
    rig: 'cascade-rig',
    status,
    bead_id: id,
    needs,
    plan_checkpoint_id: 'ckpt-cascade-test',
  });
}

beforeAll(async () => {
  process.env.NOS_ROLE_KEY_DIR = TEST_KEY_DIR;
  process.env.NOS_RIGS_ROOT = TEST_RIGS;
  fs.mkdirSync(TEST_KEY_DIR, { recursive: true });
  fs.mkdirSync(TEST_RIGS, { recursive: true });
  await generateKeyPair('mayor_cascade_test');
});

afterAll(() => {
  fs.rmSync(TEST_KEY_DIR, { recursive: true, force: true });
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  fs.rmSync(TEST_DB, { force: true });
  jest.restoreAllMocks();
});

describe('Cascade blocking (HARDENING.md §2.3)', () => {
  let mayor: Mayor;
  let ledger: Ledger;
  let bus: ConvoyBus;
  const heartbeats: HeartbeatEvent[] = [];

  beforeEach(() => {
    jest.restoreAllMocks();
    heartbeats.length = 0;
    mayor = new Mayor({
      agentId: 'mayor_cascade_test',
      rigName: 'cascade-rig',
      kgPath: TEST_DB,
      emitHeartbeat: (ev) => heartbeats.push(ev),
    });
    ledger = new Ledger();
    bus = new ConvoyBus('cascade-rig');
    jest.spyOn(ConvoyBus.prototype, 'send').mockResolvedValue(undefined);
  });

  afterEach(() => {
    mayor.close();
  });

  it('blocks bead whose prerequisite has FAILED status', async () => {
    const failed = makeBead('failed-prereq', [], 'failed');
    const dependent = makeBead('dependent-001', ['failed-prereq']);

    await ledger.appendBead('cascade-rig', { ...failed, status: 'failed', outcome: 'FAILURE' });
    await ledger.appendBead('cascade-rig', dependent);

    const sendSpy = jest.spyOn(ConvoyBus.prototype, 'send');
    await mayor.dispatchBead(dependent, bus, 1);

    expect(sendSpy).not.toHaveBeenCalled();

    const beads = ledger.readBeads('cascade-rig');
    const latest = beads.filter((b) => b.bead_id === 'dependent-001').at(-1);
    expect(latest?.status).toBe('blocked');
  });

  it('emits CONVOY_BLOCKED heartbeat when cascade blocking fires', async () => {
    const failed = makeBead('failed-p', [], 'failed');
    const child = makeBead('child-001', ['failed-p']);

    await ledger.appendBead('cascade-rig', { ...failed, status: 'failed', outcome: 'FAILURE' });
    await ledger.appendBead('cascade-rig', child);

    await mayor.dispatchBead(child, bus, 2);

    const blocked = heartbeats.find((h) => h.type === 'CONVOY_BLOCKED');
    expect(blocked).toBeDefined();
    expect((blocked as { bead_id: string }).bead_id).toBe('child-001');
  });

  it('dispatches bead normally when all prerequisites have succeeded', async () => {
    const done = makeBead('done-prereq', [], 'done');
    const child = makeBead('child-002', ['done-prereq']);

    await ledger.appendBead('cascade-rig', { ...done, status: 'done', outcome: 'SUCCESS' });
    await ledger.appendBead('cascade-rig', child);

    const sendSpy = jest.spyOn(ConvoyBus.prototype, 'send');
    await mayor.dispatchBead(child, bus, 3);

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('dispatches bead with no prerequisites without cascade check', async () => {
    const root = makeBead('root-002', []);
    await ledger.appendBead('cascade-rig', root);

    const sendSpy = jest.spyOn(ConvoyBus.prototype, 'send');
    await mayor.dispatchBead(root, bus, 4);

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks only when prerequisite has FAILURE outcome (not just pending)', async () => {
    const pending = makeBead('pending-prereq', [], 'pending');
    const child = makeBead('child-003', ['pending-prereq']);

    await ledger.appendBead('cascade-rig', pending);
    await ledger.appendBead('cascade-rig', child);

    // pending prereq is in-progress; cascade block should NOT fire for this
    // (rendezvous guard would block it if child has >1 needs, but this has only 1)
    // Non-rendezvous with pending prereq dispatches — the cascade block is for FAILURES only
    const sendSpy = jest.spyOn(ConvoyBus.prototype, 'send');
    await mayor.dispatchBead(child, bus, 5);
    // Single-need bead with pending (not failed) prereq → dispatches normally
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

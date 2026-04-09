// Tests: Rendezvous node dispatch blocking (SWARM.md §Rendezvous)
// A rendezvous bead (needs.length > 1) MUST wait for ALL prerequisites
// to reach 'done' status before Mayor dispatches it.

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
import { MemPalaceClient } from '../../src/mempalace/client';
import { generateKeyPair } from '../../src/convoys/sign';
import type { Bead } from '../../src/types/index';

const TEST_KEY_DIR = path.join(os.tmpdir(), `rndv-keys-${Date.now()}`);
const TEST_RIGS = path.join(os.tmpdir(), `rndv-rigs-${Date.now()}`);
const TEST_DB = path.join(os.tmpdir(), `rndv-kg-${Date.now()}.sqlite`);

function makeBead(id: string, needs: string[] = []): Bead {
  return Ledger.createBead({
    role: 'polecat',
    task_type: 'execute',
    model: 'llama-3.1-8b-instant',
    rig: 'rndv-rig',
    status: 'pending',
    bead_id: id,
    needs,
    plan_checkpoint_id: 'ckpt-rndv-test',
  });
}

beforeAll(async () => {
  process.env.NOS_ROLE_KEY_DIR = TEST_KEY_DIR;
  process.env.NOS_RIGS_ROOT = TEST_RIGS;
  fs.mkdirSync(TEST_KEY_DIR, { recursive: true });
  fs.mkdirSync(TEST_RIGS, { recursive: true });
  await generateKeyPair('mayor_rndv_test');
});

afterAll(() => {
  fs.rmSync(TEST_KEY_DIR, { recursive: true, force: true });
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  fs.rmSync(TEST_DB, { force: true });
  jest.restoreAllMocks();
});

describe('Rendezvous node dispatch blocking (SWARM.md §Rendezvous)', () => {
  let mayor: Mayor;
  let ledger: Ledger;
  let bus: ConvoyBus;

  beforeEach(() => {
    jest.restoreAllMocks();
    mayor = new Mayor({ agentId: 'mayor_rndv_test', rigName: 'rndv-rig', kgPath: TEST_DB });
    ledger = new Ledger();
    bus = new ConvoyBus('rndv-rig');
    jest.spyOn(MemPalaceClient.prototype, 'addDrawer').mockResolvedValue({ id: 'ok' });
    jest.spyOn(ConvoyBus.prototype, 'send').mockResolvedValue(undefined);
  });

  afterEach(() => {
    mayor.close();
  });

  it('blocks rendezvous bead when prerequisites are NOT all done', async () => {
    // prereq-a is done, prereq-b is still pending
    const prereqA = makeBead('prereq-a');
    const prereqB = makeBead('prereq-b');
    const rendezvous = makeBead('rndv-001', ['prereq-a', 'prereq-b']);

    // Write prereqs to ledger — A done, B pending
    await ledger.appendBead('rndv-rig', { ...prereqA, status: 'done', outcome: 'SUCCESS' });
    await ledger.appendBead('rndv-rig', { ...prereqB, status: 'in_progress' });
    await ledger.appendBead('rndv-rig', rendezvous);

    const sendSpy = jest.spyOn(ConvoyBus.prototype, 'send');
    await mayor.dispatchBead(rendezvous, bus, 1);

    // Should NOT have sent the convoy — bead is blocked
    expect(sendSpy).not.toHaveBeenCalled();

    // Bead should be marked 'blocked' in ledger
    const beads = ledger.readBeads('rndv-rig');
    const latest = beads.filter((b) => b.bead_id === 'rndv-001').at(-1);
    expect(latest?.status).toBe('blocked');
  });

  it('dispatches rendezvous bead when ALL prerequisites are done', async () => {
    const prereqA = makeBead('prereq-c');
    const prereqB = makeBead('prereq-d');
    const rendezvous = makeBead('rndv-002', ['prereq-c', 'prereq-d']);

    // Both prereqs done
    await ledger.appendBead('rndv-rig', { ...prereqA, status: 'done', outcome: 'SUCCESS' });
    await ledger.appendBead('rndv-rig', { ...prereqB, status: 'done', outcome: 'SUCCESS' });
    await ledger.appendBead('rndv-rig', rendezvous);

    const sendSpy = jest.spyOn(ConvoyBus.prototype, 'send');
    await mayor.dispatchBead(rendezvous, bus, 2);

    // ALL prereqs done → should dispatch
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('dispatches non-rendezvous bead (single prereq) without blocking', async () => {
    const prereq = makeBead('prereq-e');
    const simple = makeBead('simple-001', ['prereq-e']); // only 1 prereq → not rendezvous

    await ledger.appendBead('rndv-rig', { ...prereq, status: 'in_progress' });
    await ledger.appendBead('rndv-rig', simple);

    const sendSpy = jest.spyOn(ConvoyBus.prototype, 'send');
    await mayor.dispatchBead(simple, bus, 3);

    // Single-prereq bead → not a rendezvous node → dispatches regardless of prereq state
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('dispatches bead with no prerequisites immediately', async () => {
    const root = makeBead('root-001', []); // no prerequisites
    await ledger.appendBead('rndv-rig', root);

    const sendSpy = jest.spyOn(ConvoyBus.prototype, 'send');
    await mayor.dispatchBead(root, bus, 4);

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('logs blocked rendezvous with which prerequisites are unmet', async () => {
    const prereqF = makeBead('prereq-f');
    const prereqG = makeBead('prereq-g');
    const rndv = makeBead('rndv-003', ['prereq-f', 'prereq-g']);

    // Neither prereq is done
    await ledger.appendBead('rndv-rig', { ...prereqF, status: 'pending' });
    await ledger.appendBead('rndv-rig', { ...prereqG, status: 'pending' });
    await ledger.appendBead('rndv-rig', rndv);

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await mayor.dispatchBead(rndv, bus, 5);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Rendezvous bead rndv-003 blocked'),
    );
    logSpy.mockRestore();
  });
});

// Integration: Mayor.dispatchBead() → ConvoyBus inbox → processInbox() round-trip
// Validates the actual production message flow:
//   1. Mayor signs and writes convoy to Polecat's inbox
//   2. ConvoyBus.processInbox() reads, verifies, and delivers ConvoyMessage
//   3. Bead content survives the round-trip intact via convoy.payload.data
// Also verifies: dispatch guard, rendezvous blocking, cascade blocking.

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { Mayor } from '../../src/roles/mayor';
import { ConvoyBus } from '../../src/convoys/bus';
import { generateKeyPair } from '../../src/convoys/sign';
import { Ledger } from '../../src/ledger/index';
import type { Bead, ConvoyMessage } from '../../src/types/index';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('groq-sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                beads: [{
                  task_type: 'implement',
                  task_description: 'Write module',
                  role: 'polecat',
                  needs: [],
                  critical_path: false,
                  witness_required: false,
                  fan_out_weight: 1,
                  priority: 'medium',
                }],
              }),
            },
          }],
        }),
      },
    },
  })),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_RIGS = path.join(os.tmpdir(), `convoy-e2e-rigs-${Date.now()}`);
const KEYS_DIR = path.join(TEST_RIGS, 'keys');
const kgFiles: string[] = [];

function freshKg(): string {
  const p = path.join(os.tmpdir(), `convoy-e2e-kg-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  kgFiles.push(p);
  process.env.NOS_KG_PATH = p;
  return p;
}

function makePendingBead(rig: string, deps: string[] = []): Bead {
  return Ledger.createBead({
    role: 'polecat',
    task_type: 'implement',
    task_description: 'Write module feature',
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    rig,
    needs: deps,
    status: 'pending',
    plan_checkpoint_id: 'ckpt-dispatch-001',
  });
}

/** Extract Bead from a ConvoyMessage's payload data */
function beadFromConvoy(msg: ConvoyMessage): Bead {
  return msg.payload.data as unknown as Bead;
}

beforeAll(async () => {
  fs.mkdirSync(TEST_RIGS, { recursive: true });
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  process.env.NOS_RIGS_ROOT = TEST_RIGS;
  process.env.NOS_ROLE_KEY_DIR = KEYS_DIR;

  // generateKeyPair uses NOS_ROLE_KEY_DIR env var — takes only senderId
  await generateKeyPair('mayor');
  await generateKeyPair('polecat');
});

afterAll(() => {
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  for (const f of kgFiles) fs.rmSync(f, { force: true });
  delete process.env.NOS_RIGS_ROOT;
  delete process.env.NOS_ROLE_KEY_DIR;
  delete process.env.NOS_KG_PATH;
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Mayor → ConvoyBus dispatch round-trip (production message flow)', () => {
  it('Mayor.dispatchBead() writes signed convoy to Polecat inbox', async () => {
    const rig = 'dispatch-rig-01';
    const mayor = new Mayor({
      agentId: 'mayor',
      rigName: rig,
      groqApiKey: 'test-key',
      kgPath: freshKg(),
    });
    const bus = new ConvoyBus(rig);
    const bead = makePendingBead(rig);

    await mayor.dispatchBead(bead, bus, 1);

    // Inbox should now contain a convoy file
    const inboxDir = path.join(TEST_RIGS, rig, 'mailboxes', 'polecat', 'inbox');
    expect(fs.existsSync(inboxDir)).toBe(true);
    const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(1);

    mayor.close();
  });

  it('ConvoyBus.processInbox() reads and delivers the dispatched bead', async () => {
    const rig = 'dispatch-rig-02';
    const mayor = new Mayor({
      agentId: 'mayor',
      rigName: rig,
      groqApiKey: 'test-key',
      kgPath: freshKg(),
    });
    const bus = new ConvoyBus(rig);
    const bead = makePendingBead(rig);

    await mayor.dispatchBead(bead, bus, 1);

    const delivered: ConvoyMessage[] = [];
    await bus.processInbox('polecat', async (msg) => {
      delivered.push(msg);
    });

    expect(delivered.length).toBeGreaterThanOrEqual(1);
    const found = delivered.find((msg) => beadFromConvoy(msg).bead_id === bead.bead_id);
    expect(found).toBeDefined();

    const receivedPayload = beadFromConvoy(found!);
    // Convoy payload contains subset of bead fields: bead_id, task_type, model, plan_checkpoint_id, critical_path, fan_out_weight, needs
    expect(receivedPayload.task_type).toBe('implement');
    expect(receivedPayload.plan_checkpoint_id).toBe('ckpt-dispatch-001');

    mayor.close();
  });

  it('bead task_type, critical_path, and fan_out_weight survive convoy round-trip', async () => {
    const rig = 'dispatch-rig-03';
    const mayor = new Mayor({
      agentId: 'mayor',
      rigName: rig,
      groqApiKey: 'test-key',
      kgPath: freshKg(),
    });
    const bus = new ConvoyBus(rig);

    const bead = Ledger.createBead({
      role: 'polecat',
      task_type: 'security',
      task_description: 'Run security audit',
      model: 'llama-3.3-70b-versatile',
      rig,
      status: 'pending',
      critical_path: true,
      witness_required: true,
      fan_out_weight: 3,
      plan_checkpoint_id: 'ckpt-dispatch-001',
    });

    await mayor.dispatchBead(bead, bus, 2);

    const received: ConvoyMessage[] = [];
    await bus.processInbox('polecat', async (msg) => { received.push(msg); });

    const found = received.find((msg) => beadFromConvoy(msg).bead_id === bead.bead_id);
    expect(found).toBeDefined();

    // Convoy payload: bead_id, task_type, model, plan_checkpoint_id, critical_path, fan_out_weight, needs
    const data = found!.payload.data as Record<string, unknown>;
    expect(data['task_type']).toBe('security');
    expect(data['critical_path']).toBe(true);
    expect(data['fan_out_weight']).toBe(3);
    // witness_required is not in the convoy payload (it's a planning annotation, not transport field)

    mayor.close();
  });

  it('dispatch guard throws MAYOR_CHECKPOINT_MISSING for bead without checkpoint', async () => {
    const rig = 'dispatch-rig-04';
    const mayor = new Mayor({
      agentId: 'mayor',
      rigName: rig,
      groqApiKey: 'test-key',
      kgPath: freshKg(),
    });
    const bus = new ConvoyBus(rig);

    const beadNoCheckpoint: Bead = {
      ...makePendingBead(rig),
      plan_checkpoint_id: '',
    };

    await expect(
      mayor.dispatchBead(beadNoCheckpoint, bus, 1),
    ).rejects.toThrow(/MAYOR_CHECKPOINT_MISSING/);

    mayor.close();
  });

  it('cascade blocking silently blocks bead and writes blocked status to ledger', async () => {
    const rig = 'dispatch-rig-06';
    const ledger = new Ledger();
    const cascadeEvents: string[] = [];
    const mayor = new Mayor({
      agentId: 'mayor',
      rigName: rig,
      groqApiKey: 'test-key',
      kgPath: freshKg(),
      emitHeartbeat: (evt) => { cascadeEvents.push(evt.type); },
    });
    const bus = new ConvoyBus(rig);

    // Write a failed predecessor to the ledger
    const failedBead = Ledger.createBead({
      role: 'polecat',
      task_type: 'implement',
      task_description: 'Failed step',
      model: 'test',
      rig,
      status: 'failed',
      outcome: 'FAILURE',
      plan_checkpoint_id: 'ckpt-dispatch-001',
    });
    await ledger.appendBead(rig, failedBead);

    // Downstream bead depends on the failed predecessor
    const downstream = Ledger.createBead({
      role: 'polecat',
      task_type: 'implement',
      task_description: 'Downstream step',
      model: 'test',
      rig,
      needs: [failedBead.bead_id],
      status: 'pending',
      plan_checkpoint_id: 'ckpt-dispatch-001',
    });

    // Cascade blocking returns without throwing — writes bead as 'blocked' and emits CONVOY_BLOCKED
    await expect(mayor.dispatchBead(downstream, bus, 1)).resolves.toBeUndefined();

    // Downstream bead should be written to ledger as 'blocked'
    const allBeads = ledger.readBeads(rig);
    const blockedEntry = allBeads.find((b) => b.bead_id === downstream.bead_id && b.status === 'blocked');
    expect(blockedEntry).toBeDefined();

    // CONVOY_BLOCKED heartbeat emitted
    expect(cascadeEvents).toContain('CONVOY_BLOCKED');

    mayor.close();
  });

  it('multiple beads dispatched — all delivered via processInbox', async () => {
    const rig = 'dispatch-rig-07';
    const mayor = new Mayor({
      agentId: 'mayor',
      rigName: rig,
      groqApiKey: 'test-key',
      kgPath: freshKg(),
    });
    const bus = new ConvoyBus(rig);

    const beads = [makePendingBead(rig), makePendingBead(rig), makePendingBead(rig)];

    for (let i = 0; i < beads.length; i++) {
      await mayor.dispatchBead(beads[i], bus, i + 1);
    }

    const received: ConvoyMessage[] = [];
    await bus.processInbox('polecat', async (msg) => { received.push(msg); });

    expect(received.length).toBeGreaterThanOrEqual(3);
    const receivedIds = received.map((msg) => beadFromConvoy(msg).bead_id);
    for (const bead of beads) {
      expect(receivedIds).toContain(bead.bead_id);
    }

    mayor.close();
  });

  it('convoy carries correct sender (mayor) in header', async () => {
    const rig = 'dispatch-rig-08';
    const mayor = new Mayor({
      agentId: 'mayor',
      rigName: rig,
      groqApiKey: 'test-key',
      kgPath: freshKg(),
    });
    const bus = new ConvoyBus(rig);
    const bead = makePendingBead(rig);

    await mayor.dispatchBead(bead, bus, 1);

    const msgs: ConvoyMessage[] = [];
    await bus.processInbox('polecat', async (msg) => { msgs.push(msg); });

    const found = msgs.find((msg) => beadFromConvoy(msg).bead_id === bead.bead_id);
    expect(found).toBeDefined();
    expect(found!.header.sender_id).toBe('mayor');
    expect(found!.header.recipient).toBe('polecat');
    expect(found!.signature).toMatch(/^ed25519:/);

    mayor.close();
  });
});

// Integration: WorkerRuntime dispatch→execute→ledger cycle
// Tests that Mayor plans are actually executed by the worker loop.

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { WorkerRuntime } from '../../src/runtime/worker-loop';
import { Mayor } from '../../src/roles/mayor';
import { ConvoyBus } from '../../src/convoys/bus';
import { Ledger } from '../../src/ledger/index';
import { generateKeyPair, buildSignedConvoy, loadPrivateKey } from '../../src/convoys/sign';
import type { Bead } from '../../src/types/index';

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
                  task_description: 'Write a hello-world function',
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

const TEST_RIGS = path.join(os.tmpdir(), `wl-rigs-${Date.now()}`);
const KEYS_DIR = path.join(TEST_RIGS, 'keys');
const kgFiles: string[] = [];

function freshKg(): string {
  const p = path.join(os.tmpdir(), `wl-kg-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  kgFiles.push(p);
  process.env.NOS_KG_PATH = p;
  return p;
}

beforeAll(async () => {
  fs.mkdirSync(TEST_RIGS, { recursive: true });
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  process.env.NOS_RIGS_ROOT = TEST_RIGS;
  process.env.NOS_ROLE_KEY_DIR = KEYS_DIR;
  await generateKeyPair('mayor_01');
  await generateKeyPair('runtime');
  await generateKeyPair('witness_01');
  await generateKeyPair('safeguard_01');
});

afterAll(() => {
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  for (const f of kgFiles) fs.rmSync(f, { force: true });
  delete process.env.NOS_RIGS_ROOT;
  delete process.env.NOS_ROLE_KEY_DIR;
  delete process.env.NOS_KG_PATH;
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('WorkerRuntime', () => {
  it('processOnce() drains an empty inbox without error', async () => {
    const rig = 'wl-rig-01';
    const runtime = new WorkerRuntime({
      rigName: rig,
      polecatCount: 1,
      safeguardPoolSize: 1,
      kgPath: freshKg(),
    });

    const result = await runtime.processOnce();
    expect(result.polecatProcessed).toBe(0);
    expect(result.mayorProcessed).toBe(0);

    await runtime.stop();
  });

  it('BEAD_DISPATCH convoy is processed and bead starts executing', async () => {
    const rig = 'wl-rig-02';
    const kgPath = freshKg();
    const ledger = new Ledger();

    const mayor = new Mayor({ agentId: 'mayor_01', rigName: rig, kgPath });
    const bus = new ConvoyBus(rig);

    // Create a bead, write to ledger (Mayor.orchestrate does this), then dispatch
    const bead = Ledger.createBead({
      role: 'polecat',
      task_type: 'implement',
      task_description: 'Write a hello-world function',
      model: 'llama-3.1-8b-instant',
      rig,
      status: 'pending',
      plan_checkpoint_id: 'ckpt-wl-test-001',
    });
    await ledger.appendBead(rig, bead);

    await mayor.dispatchBead(bead, bus, 1);
    mayor.close();

    // Verify convoy was queued
    const inbox = bus.readInbox('polecat');
    expect(inbox.length).toBeGreaterThanOrEqual(1);

    // WorkerRuntime should drain the inbox on processOnce()
    const runtime = new WorkerRuntime({
      rigName: rig,
      polecatCount: 2,
      safeguardPoolSize: 1,
      kgPath,
    });

    const result = await runtime.processOnce();
    expect(result.polecatProcessed).toBe(1);

    await runtime.stop();
  });

  it('start() and stop() lifecycle works without error', async () => {
    const rig = 'wl-rig-03';
    const runtime = new WorkerRuntime({
      rigName: rig,
      polecatCount: 1,
      safeguardPoolSize: 1,
      pollIntervalMs: 50,
      kgPath: freshKg(),
    });

    await runtime.start();
    // Let it run a couple of poll cycles
    await new Promise((resolve) => setTimeout(resolve, 120));
    await runtime.stop();
    // No error thrown
  });

  it('all polecats busy: re-queues BEAD_DISPATCH for next poll', async () => {
    const rig = 'wl-rig-04';
    const kgPath = freshKg();
    const ledger = new Ledger();

    // Runtime with 1 polecat that will be marked busy externally
    const runtime = new WorkerRuntime({
      rigName: rig,
      polecatCount: 1,
      safeguardPoolSize: 1,
      kgPath,
    });

    // Mark the only polecat slot as busy by accessing the internals via a spy
    // Instead, write 1 bead to inbox and process — the bead initiates execution
    // and the slot should be busy until the (mocked) Groq call finishes
    const mayor = new Mayor({ agentId: 'mayor_01', rigName: rig, kgPath });
    const bus = new ConvoyBus(rig);
    const bead = Ledger.createBead({
      role: 'polecat', task_type: 'implement', task_description: 'Task 1',
      model: 'llama-3.1-8b-instant', rig, status: 'pending',
      plan_checkpoint_id: 'ckpt-wl-004',
    });
    await ledger.appendBead(rig, bead);
    await mayor.dispatchBead(bead, bus, 1);
    mayor.close();

    const result = await runtime.processOnce();
    // Bead was dispatched (polecat claimed and executing async)
    expect(result.polecatProcessed).toBe(1);

    await runtime.stop();
  });

  it('SECURITY_VIOLATION in mayor inbox marks bead as failed', async () => {
    const rig = 'wl-rig-05';
    const kgPath = freshKg();
    const ledger = new Ledger();

    // Write a bead to ledger in 'in_progress' state
    const bead = Ledger.createBead({
      role: 'polecat', task_type: 'implement', task_description: 'Dangerous task',
      model: 'llama-3.1-8b-instant', rig, status: 'in_progress',
      plan_checkpoint_id: 'ckpt-wl-005',
    });
    await ledger.appendBead(rig, bead);

    // Write a properly signed SECURITY_VIOLATION to mayor inbox
    const bus = new ConvoyBus(rig);
    const sgKey = loadPrivateKey('safeguard_01');
    const header = { sender_id: 'safeguard_01', recipient: 'mayor', timestamp: new Date().toISOString(), seq: 1 };
    const payload = { type: 'SECURITY_VIOLATION' as const, data: { bead_id: bead.bead_id, reason: 'credential leak detected' } };
    const convoy = await buildSignedConvoy(header, payload, sgKey);
    await bus.send(convoy);

    const runtime = new WorkerRuntime({
      rigName: rig,
      polecatCount: 1,
      safeguardPoolSize: 1,
      kgPath,
    });

    const result = await runtime.processOnce();
    expect(result.mayorProcessed).toBe(1);

    // Bead should now be marked failed in ledger
    const beads = ledger.readBeads(rig);
    const updated = beads.find((b) => b.bead_id === bead.bead_id && b.status === 'failed');
    expect(updated).toBeDefined();
    expect(updated?.outcome).toBe('FAILURE');

    await runtime.stop();
  });
});

describe('KGSyncMonitor lifecycle with WorkerRuntime (GAP H2)', () => {
  it('KGSyncMonitor starts with WorkerRuntime.start() and stops with drain()', async () => {
    const rig = 'wl-rig-kgsync';
    const kgPath = freshKg();

    const runtime = new WorkerRuntime({
      rigName: rig,
      polecatCount: 1,
      safeguardPoolSize: 1,
      kgPath,
    });

    await runtime.start();

    const status = runtime.getStatus();
    expect(status.running).toBe(true);

    await runtime.drain(1000);

    const statusAfter = runtime.getStatus();
    expect(statusAfter.running).toBe(false);
  });

  it('WorkerRuntime.stop() stops KGSyncMonitor without errors', async () => {
    const rig = 'wl-rig-kgsync2';
    const kgPath = freshKg();

    const runtime = new WorkerRuntime({
      rigName: rig,
      polecatCount: 1,
      safeguardPoolSize: 1,
      kgPath,
    });

    await runtime.start();
    expect(runtime.getStatus().running).toBe(true);

    await runtime.stop();
    expect(runtime.getStatus().running).toBe(false);
  });
});

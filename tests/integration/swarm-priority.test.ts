// Integration: Critical-path bead starvation prevention (RISKS.md R-004)
// Validates that the ConvoyBus priority-aware draining puts critical-path and
// high-fan-out beads ahead of low-priority standalone work under mixed load.

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ConvoyBus } from '../../src/convoys/bus';
import { buildSignedConvoy, generateKeyPair, loadPrivateKey } from '../../src/convoys/sign';
import type { ConvoyMessage } from '../../src/types/index';

const TEST_KEY_DIR = path.join(os.tmpdir(), `swarm-pri-keys-${Date.now()}`);
const TEST_RIGS = path.join(os.tmpdir(), `swarm-pri-rigs-${Date.now()}`);

beforeAll(async () => {
  process.env.NOS_ROLE_KEY_DIR = TEST_KEY_DIR;
  process.env.NOS_RIGS_ROOT = TEST_RIGS;
  fs.mkdirSync(TEST_KEY_DIR, { recursive: true });
  fs.mkdirSync(TEST_RIGS, { recursive: true });
  await generateKeyPair('mayor_pri');
});

afterAll(() => {
  fs.rmSync(TEST_KEY_DIR, { recursive: true, force: true });
  fs.rmSync(TEST_RIGS, { recursive: true, force: true });
  delete process.env.NOS_ROLE_KEY_DIR;
  delete process.env.NOS_RIGS_ROOT;
});

async function makeConvoy(
  bus: ConvoyBus,
  beadId: string,
  opts: { criticalPath?: boolean; fanOutWeight?: number; priority?: string },
): Promise<ConvoyMessage> {
  const seq = bus.getNextSeq('mayor_pri');
  const privateKey = loadPrivateKey('mayor_pri');
  return buildSignedConvoy(
    { sender_id: 'mayor_pri', recipient: 'polecat', seq, timestamp: new Date().toISOString() },
    {
      type: 'BEAD_DISPATCH',
      data: {
        bead_id: beadId,
        plan_checkpoint_id: 'ckpt-pri-test',
        critical_path: opts.criticalPath ?? false,
        fan_out_weight: opts.fanOutWeight ?? 1,
        priority: opts.priority ?? 'normal',
      },
    },
    privateKey,
  );
}

describe('ConvoyBus priority-aware draining (R-004 — critical bead starvation)', () => {
  it('critical_path convoys drain before non-critical ones', async () => {
    const bus = new ConvoyBus('pri-rig-1');
    const processedOrder: string[] = [];

    // Write mixed convoys: some low-priority, then one critical
    const low1 = await makeConvoy(bus, 'low-bead-001', { criticalPath: false, priority: 'low' });
    const low2 = await makeConvoy(bus, 'low-bead-002', { criticalPath: false, priority: 'low' });
    const critical = await makeConvoy(bus, 'critical-bead-001', { criticalPath: true, fanOutWeight: 5 });
    const low3 = await makeConvoy(bus, 'low-bead-003', { criticalPath: false, priority: 'low' });

    // Save in FIFO order (low first, then critical, then low)
    bus.saveToMailbox(low1);
    bus.saveToMailbox(low2);
    bus.saveToMailbox(critical);
    bus.saveToMailbox(low3);

    await bus.processInbox('polecat', async (convoy) => {
      processedOrder.push(convoy.payload.data['bead_id'] as string);
    });

    // Critical bead must be processed before any low-priority beads
    const critIdx = processedOrder.indexOf('critical-bead-001');
    const lowIdx = Math.min(
      processedOrder.indexOf('low-bead-001'),
      processedOrder.indexOf('low-bead-002'),
      processedOrder.indexOf('low-bead-003'),
    );
    expect(critIdx).toBeLessThan(lowIdx);
  });

  it('high fan_out_weight convoys drain before low fan-out', async () => {
    const bus = new ConvoyBus('pri-rig-2');
    const processedOrder: string[] = [];

    const lowFan = await makeConvoy(bus, 'low-fan-001', { fanOutWeight: 1 });
    const highFan = await makeConvoy(bus, 'high-fan-001', { fanOutWeight: 15 });
    const midFan = await makeConvoy(bus, 'mid-fan-001', { fanOutWeight: 5 });

    bus.saveToMailbox(lowFan);
    bus.saveToMailbox(highFan);
    bus.saveToMailbox(midFan);

    await bus.processInbox('polecat', async (convoy) => {
      processedOrder.push(convoy.payload.data['bead_id'] as string);
    });

    const highIdx = processedOrder.indexOf('high-fan-001');
    const midIdx = processedOrder.indexOf('mid-fan-001');
    const lowIdx = processedOrder.indexOf('low-fan-001');

    // High fan-out drains first, then mid, then low
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it('critical_path with high fan_out always leads the queue', async () => {
    const bus = new ConvoyBus('pri-rig-3');
    const processedOrder: string[] = [];

    const normal = await makeConvoy(bus, 'normal-001', { priority: 'normal', fanOutWeight: 3 });
    const highFan = await makeConvoy(bus, 'high-fan-001', { fanOutWeight: 20 });
    const critHighFan = await makeConvoy(bus, 'crit-high-001', { criticalPath: true, fanOutWeight: 20 });

    bus.saveToMailbox(normal);
    bus.saveToMailbox(highFan);
    bus.saveToMailbox(critHighFan);

    await bus.processInbox('polecat', async (convoy) => {
      processedOrder.push(convoy.payload.data['bead_id'] as string);
    });

    // critical_path + high_fan_out beats non-critical high_fan_out
    expect(processedOrder[0]).toBe('crit-high-001');
  });

  it('FIFO is preserved within same priority class', async () => {
    const bus = new ConvoyBus('pri-rig-4');
    const processedOrder: string[] = [];

    // All same priority (normal, fan_out=1) — FIFO order must be preserved
    const b1 = await makeConvoy(bus, 'fifo-001', { priority: 'normal', fanOutWeight: 1 });
    const b2 = await makeConvoy(bus, 'fifo-002', { priority: 'normal', fanOutWeight: 1 });
    const b3 = await makeConvoy(bus, 'fifo-003', { priority: 'normal', fanOutWeight: 1 });

    bus.saveToMailbox(b1);
    bus.saveToMailbox(b2);
    bus.saveToMailbox(b3);

    await bus.processInbox('polecat', async (convoy) => {
      processedOrder.push(convoy.payload.data['bead_id'] as string);
    });

    expect(processedOrder).toEqual(['fifo-001', 'fifo-002', 'fifo-003']);
  });
});

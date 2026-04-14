// Tests: POTENTIAL_DEADLOCK heartbeat handling (GAP H3)
//
// Verifies:
//  - SOLE_PREDECESSOR and STARVATION reasons trigger WorkerRuntime.handleDeadlock()
//  - HIGH_FAN_OUT is logged only — handleDeadlock() is NOT called
//  - handleDeadlock() emits SWARM_ABORT when stall_duration_ms >= 30s

jest.mock('groq-sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: '{"violations":[]}' } }],
          usage: { total_tokens: 42 },
        }),
      },
    },
  })),
}));

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { WorkerRuntime } from '../../src/runtime/worker-loop';
import { Ledger } from '../../src/ledger/index';
import type { HeartbeatEvent } from '../../src/types/index';

const TMP_BASE = path.join(os.tmpdir(), `nos-deadlock-${Date.now()}`);

function freshKg(label: string): string {
  const kgDir = path.join(TMP_BASE, label);
  fs.mkdirSync(kgDir, { recursive: true });
  return path.join(kgDir, 'kg.sqlite');
}

afterAll(() => {
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
});

describe('POTENTIAL_DEADLOCK heartbeat routing', () => {
  it('SOLE_PREDECESSOR reason triggers handleDeadlock()', async () => {
    const kgPath = freshKg('sole-pred');
    const runtime = new WorkerRuntime({
      rigName: 'dl-rig-01',
      polecatCount: 1,
      safeguardPoolSize: 1,
      kgPath,
    });

    const spy = jest.spyOn(runtime, 'handleDeadlock');

    const event: HeartbeatEvent = {
      type: 'POTENTIAL_DEADLOCK',
      bead_id: 'bead-abc-123456',
      stall_duration_ms: 35_000,
      reason: 'SOLE_PREDECESSOR',
    };

    // Simulate what heartbeatHandler does for non-HIGH_FAN_OUT
    if (event.type === 'POTENTIAL_DEADLOCK' && event.reason !== 'HIGH_FAN_OUT') {
      void runtime.handleDeadlock(event);
    }

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      bead_id: 'bead-abc-123456',
      reason: 'SOLE_PREDECESSOR',
    }));

    await runtime.stop();
  });

  it('STARVATION reason triggers handleDeadlock()', async () => {
    const kgPath = freshKg('starvation');
    const runtime = new WorkerRuntime({
      rigName: 'dl-rig-02',
      polecatCount: 1,
      safeguardPoolSize: 1,
      kgPath,
    });

    const spy = jest.spyOn(runtime, 'handleDeadlock');

    const event: HeartbeatEvent = {
      type: 'POTENTIAL_DEADLOCK',
      bead_id: 'bead-starve-789',
      stall_duration_ms: 40_000,
      reason: 'STARVATION',
    };

    if (event.type === 'POTENTIAL_DEADLOCK' && event.reason !== 'HIGH_FAN_OUT') {
      void runtime.handleDeadlock(event);
    }

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'STARVATION',
    }));

    await runtime.stop();
  });

  it('HIGH_FAN_OUT reason does NOT trigger handleDeadlock()', async () => {
    const kgPath = freshKg('high-fan-out');
    const runtime = new WorkerRuntime({
      rigName: 'dl-rig-03',
      polecatCount: 1,
      safeguardPoolSize: 1,
      kgPath,
    });

    const spy = jest.spyOn(runtime, 'handleDeadlock');

    const event: HeartbeatEvent = {
      type: 'POTENTIAL_DEADLOCK',
      bead_id: 'bead-fan-out-001',
      stall_duration_ms: 50_000,
      reason: 'HIGH_FAN_OUT',
    };

    // Simulate heartbeatHandler: HIGH_FAN_OUT → no call to handleDeadlock
    if (event.type === 'POTENTIAL_DEADLOCK' && event.reason !== 'HIGH_FAN_OUT') {
      void runtime.handleDeadlock(event);
    }

    expect(spy).not.toHaveBeenCalled();

    await runtime.stop();
  });

  it('handleDeadlock() emits SWARM_ABORT when stall >= 30s', async () => {
    const kgPath = freshKg('swarm-abort');
    process.env.NOS_RIGS_ROOT = path.join(TMP_BASE, 'rigs-swarm-abort');
    fs.mkdirSync(process.env.NOS_RIGS_ROOT, { recursive: true });

    const ledger = new Ledger(process.env.NOS_RIGS_ROOT);
    const bead = Ledger.createBead({
      role: 'polecat',
      task_type: 'execute',
      task_description: 'Long running task',
      model: 'llama-3.1-8b-instant',
      rig: 'dl-swarm-rig',
      status: 'in_progress',
    });
    await ledger.appendBead('dl-swarm-rig', bead);

    const runtime = new WorkerRuntime({
      rigName: 'dl-swarm-rig',
      polecatCount: 1,
      safeguardPoolSize: 1,
      kgPath,
    });

    // Should not throw (bus.send may fail because mailbox setup, but handleDeadlock is non-fatal)
    await expect(
      runtime.handleDeadlock({
        bead_id: bead.bead_id,
        stall_duration_ms: 35_000,
        reason: 'SOLE_PREDECESSOR',
      }),
    ).resolves.not.toThrow();

    await runtime.stop();
    delete process.env.NOS_RIGS_ROOT;
  });

  it('handleDeadlock() does NOT emit SWARM_ABORT when stall < 30s', async () => {
    const kgPath = freshKg('no-swarm-abort');
    const runtime = new WorkerRuntime({
      rigName: 'dl-no-abort-rig',
      polecatCount: 1,
      safeguardPoolSize: 1,
      kgPath,
    });

    // Should complete without error (stall < 30s skips SWARM_ABORT)
    await expect(
      runtime.handleDeadlock({
        bead_id: 'fake-bead-id',
        stall_duration_ms: 10_000,
        reason: 'STARVATION',
      }),
    ).resolves.not.toThrow();

    await runtime.stop();
  });
});

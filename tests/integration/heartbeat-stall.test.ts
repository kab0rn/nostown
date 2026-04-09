// Integration Tests: Stalled polecat detected by heartbeat monitor

import { HeartbeatMonitor } from '../../src/monitor/heartbeat';
import type { HeartbeatEvent } from '../../src/types/index';

// Mock Polecat for testing
class MockPolecat {
  private _lastActivity: Date;
  private _currentBeadId: string | null;

  constructor(lastActivityMs?: number, beadId?: string) {
    this._lastActivity = new Date(Date.now() - (lastActivityMs ?? 0));
    this._currentBeadId = beadId ?? null;
  }

  get lastActivity(): Date {
    return this._lastActivity;
  }

  get currentBeadId(): string | null {
    return this._currentBeadId;
  }

  setLastActivity(ms: number): void {
    this._lastActivity = new Date(Date.now() - ms);
  }

  setBeadId(id: string | null): void {
    this._currentBeadId = id;
  }
}

// Mock Mayor for testing
class MockMayor {
  private _lastHeartbeat: Date;

  constructor(lastHeartbeatMs?: number) {
    this._lastHeartbeat = new Date(Date.now() - (lastHeartbeatMs ?? 0));
  }

  get lastHeartbeat(): Date {
    return this._lastHeartbeat;
  }

  setLastHeartbeat(ms: number): void {
    this._lastHeartbeat = new Date(Date.now() - ms);
  }
}

describe('HeartbeatMonitor — stalled polecat detection', () => {
  it('does not emit event for active polecat', () => {
    const events: HeartbeatEvent[] = [];
    const monitor = new HeartbeatMonitor({
      polecatStallThresholdMs: 5000,
      onEvent: (e) => events.push(e),
    });

    // Active polecat: last activity 1 second ago
    const polecat = new MockPolecat(1000, 'active-bead');
    monitor.registerPolecat('polecat_01', polecat as any);

    monitor.checkOnce();
    expect(events.filter((e) => e.type === 'POLECAT_STALLED')).toHaveLength(0);
  });

  it('emits POLECAT_STALLED for stalled polecat with active bead', () => {
    const events: HeartbeatEvent[] = [];
    const monitor = new HeartbeatMonitor({
      polecatStallThresholdMs: 5000,
      onEvent: (e) => events.push(e),
    });

    // Stalled polecat: last activity 10 seconds ago (above 5s threshold)
    const polecat = new MockPolecat(10000, 'stalled-bead');
    monitor.registerPolecat('polecat_stalled', polecat as any);

    monitor.checkOnce();

    const stalledEvents = events.filter((e) => e.type === 'POLECAT_STALLED');
    expect(stalledEvents).toHaveLength(1);

    const event = stalledEvents[0] as Extract<HeartbeatEvent, { type: 'POLECAT_STALLED' }>;
    expect(event.agent_id).toBe('polecat_stalled');
    expect(event.bead_id).toBe('stalled-bead');
    expect(event.stall_duration_ms).toBeGreaterThan(5000);
  });

  it('does not emit POLECAT_STALLED when polecat has no active bead', () => {
    const events: HeartbeatEvent[] = [];
    const monitor = new HeartbeatMonitor({
      polecatStallThresholdMs: 1000,
      onEvent: (e) => events.push(e),
    });

    // Old activity but no active bead
    const polecat = new MockPolecat(60000, undefined);
    monitor.registerPolecat('idle_polecat', polecat as any);

    monitor.checkOnce();
    expect(events.filter((e) => e.type === 'POLECAT_STALLED')).toHaveLength(0);
  });

  it('monitors multiple polecats simultaneously', () => {
    const events: HeartbeatEvent[] = [];
    const monitor = new HeartbeatMonitor({
      polecatStallThresholdMs: 3000,
      onEvent: (e) => events.push(e),
    });

    const active = new MockPolecat(1000, 'bead-active');
    const stalled1 = new MockPolecat(10000, 'bead-stalled-1');
    const stalled2 = new MockPolecat(20000, 'bead-stalled-2');

    monitor.registerPolecat('active_p', active as any);
    monitor.registerPolecat('stalled_p1', stalled1 as any);
    monitor.registerPolecat('stalled_p2', stalled2 as any);

    monitor.checkOnce();

    const stalledEvents = events.filter((e) => e.type === 'POLECAT_STALLED');
    expect(stalledEvents).toHaveLength(2);
    expect(stalledEvents.map((e) => (e as any).agent_id)).toContain('stalled_p1');
    expect(stalledEvents.map((e) => (e as any).agent_id)).toContain('stalled_p2');
  });
});

describe('HeartbeatMonitor — MAYOR_MISSING detection', () => {
  it('emits MAYOR_MISSING when mayor heartbeat is overdue', () => {
    const events: HeartbeatEvent[] = [];
    const monitor = new HeartbeatMonitor({
      mayorMissingThresholdMs: 5000,
      onEvent: (e) => events.push(e),
    });

    // Mayor last seen 10 seconds ago (above 5s threshold)
    const mayor = new MockMayor(10000);
    monitor.registerMayor(mayor as any, 2500);

    monitor.checkOnce();

    const missingEvents = events.filter((e) => e.type === 'MAYOR_MISSING');
    expect(missingEvents).toHaveLength(1);
  });

  it('does not emit MAYOR_MISSING for healthy mayor', () => {
    const events: HeartbeatEvent[] = [];
    const monitor = new HeartbeatMonitor({
      mayorMissingThresholdMs: 30000,
      onEvent: (e) => events.push(e),
    });

    const mayor = new MockMayor(1000); // Active 1 second ago
    monitor.registerMayor(mayor as any, 15000);

    monitor.checkOnce();
    expect(events.filter((e) => e.type === 'MAYOR_MISSING')).toHaveLength(0);
  });
});

describe('HeartbeatMonitor — lifecycle', () => {
  it('collects events and can be cleared', () => {
    const monitor = new HeartbeatMonitor({ polecatStallThresholdMs: 100 });
    const polecat = new MockPolecat(1000, 'some-bead');
    monitor.registerPolecat('p', polecat as any);

    monitor.checkOnce();
    expect(monitor.getEvents().length).toBeGreaterThan(0);

    monitor.clearEvents();
    expect(monitor.getEvents().length).toBe(0);
  });

  it('start and stop do not throw', () => {
    const monitor = new HeartbeatMonitor({ pollIntervalMs: 1000 });
    expect(() => monitor.start()).not.toThrow();
    expect(() => monitor.start()).not.toThrow(); // idempotent
    expect(() => monitor.stop()).not.toThrow();
    expect(() => monitor.stop()).not.toThrow(); // idempotent
  });
});

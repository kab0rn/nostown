// Tests: HeartbeatMonitor early escalation heuristics (SWARM.md §2.1)
// Verifies that HIGH_FAN_OUT, SOLE_PREDECESSOR, and STARVATION escalations
// fire before the 15-minute hard timeout.

import { HeartbeatMonitor } from '../../src/monitor/heartbeat';

const EARLY_MS = 5 * 60 * 1000;    // 5 min
const HARD_MS  = 15 * 60 * 1000;   // 15 min

describe('HeartbeatMonitor — early escalation (SWARM.md §2.1)', () => {
  it('escalates HIGH_FAN_OUT bead at 5min, not 15min', () => {
    const events: ReturnType<HeartbeatMonitor['getEvents']> = [];
    const monitor = new HeartbeatMonitor({
      polecatStallThresholdMs: HARD_MS,
      earlyEscalationThresholdMs: EARLY_MS,
      onEvent: (e) => events.push(e),
    });

    // Register a bead with fan_out >= 10
    monitor.registerWaitingBead('high-fan-bead', 10, false);

    // Backdate waiting start to 6 minutes ago (past early threshold)
    const tracked = (monitor as unknown as { trackedBeads: Map<string, { waitingStart: Date }> }).trackedBeads;
    const bead = tracked.get('high-fan-bead');
    if (bead) bead.waitingStart = new Date(Date.now() - (EARLY_MS + 60_000));

    const fired = monitor.checkOnce();

    expect(fired.length).toBeGreaterThan(0);
    const deadlock = fired.find((e) => e.type === 'POTENTIAL_DEADLOCK');
    expect(deadlock).toBeDefined();
    if (deadlock?.type === 'POTENTIAL_DEADLOCK') {
      expect(deadlock.reason).toBe('HIGH_FAN_OUT');
      // Stall duration is under 15 minutes — so it fired early
      expect(deadlock.stall_duration_ms).toBeLessThan(HARD_MS);
    }
  });

  it('does NOT escalate low-fan-out bead before 5min', () => {
    const events: ReturnType<HeartbeatMonitor['getEvents']> = [];
    const monitor = new HeartbeatMonitor({
      polecatStallThresholdMs: HARD_MS,
      earlyEscalationThresholdMs: EARLY_MS,
      onEvent: (e) => events.push(e),
    });

    monitor.registerWaitingBead('low-fan-bead', 3, false);

    // Backdate to only 3 minutes ago (before early threshold)
    const tracked = (monitor as unknown as { trackedBeads: Map<string, { waitingStart: Date }> }).trackedBeads;
    const bead = tracked.get('low-fan-bead');
    if (bead) bead.waitingStart = new Date(Date.now() - 3 * 60 * 1000);

    const fired = monitor.checkOnce();
    const deadlock = fired.find((e) => e.type === 'POTENTIAL_DEADLOCK');
    expect(deadlock).toBeUndefined();
  });

  it('escalates SOLE_PREDECESSOR bead at 5min', () => {
    const events: ReturnType<HeartbeatMonitor['getEvents']> = [];
    const monitor = new HeartbeatMonitor({
      polecatStallThresholdMs: HARD_MS,
      earlyEscalationThresholdMs: EARLY_MS,
      onEvent: (e) => events.push(e),
    });

    // fan_out = 1, but isSolePredecessor = true
    monitor.registerWaitingBead('sole-pred-bead', 1, true);

    const tracked = (monitor as unknown as { trackedBeads: Map<string, { waitingStart: Date }> }).trackedBeads;
    const bead = tracked.get('sole-pred-bead');
    if (bead) bead.waitingStart = new Date(Date.now() - (EARLY_MS + 60_000));

    const fired = monitor.checkOnce();
    const deadlock = fired.find((e) => e.type === 'POTENTIAL_DEADLOCK');
    expect(deadlock).toBeDefined();
    if (deadlock?.type === 'POTENTIAL_DEADLOCK') {
      expect(deadlock.reason).toBe('SOLE_PREDECESSOR');
    }
  });

  it('escalates STARVATION after 3 bypasses regardless of wait time', () => {
    const events: ReturnType<HeartbeatMonitor['getEvents']> = [];
    const monitor = new HeartbeatMonitor({
      polecatStallThresholdMs: HARD_MS,
      earlyEscalationThresholdMs: EARLY_MS,
      onEvent: (e) => events.push(e),
    });

    monitor.registerWaitingBead('starved-bead', 2, false);

    // Record 3 bypasses — should trigger immediately
    monitor.recordBypass('starved-bead');
    monitor.recordBypass('starved-bead');
    monitor.recordBypass('starved-bead');

    // The 3rd bypass should have fired STARVATION
    expect(events.length).toBeGreaterThan(0);
    const deadlock = events.find((e) => e.type === 'POTENTIAL_DEADLOCK');
    expect(deadlock).toBeDefined();
    if (deadlock?.type === 'POTENTIAL_DEADLOCK') {
      expect(deadlock.reason).toBe('STARVATION');
    }
  });

  it('does not double-escalate the same bead', () => {
    const events: ReturnType<HeartbeatMonitor['getEvents']> = [];
    const monitor = new HeartbeatMonitor({
      polecatStallThresholdMs: HARD_MS,
      earlyEscalationThresholdMs: EARLY_MS,
      onEvent: (e) => events.push(e),
    });

    monitor.registerWaitingBead('once-bead', 15, false);

    const tracked = (monitor as unknown as { trackedBeads: Map<string, { waitingStart: Date }> }).trackedBeads;
    const bead = tracked.get('once-bead');
    if (bead) bead.waitingStart = new Date(Date.now() - (EARLY_MS + 60_000));

    monitor.checkOnce();
    monitor.checkOnce(); // second poll — should not fire again

    const deadlocks = events.filter((e) => e.type === 'POTENTIAL_DEADLOCK');
    expect(deadlocks.length).toBe(1);
  });

  it('clears bead tracking after unregister', () => {
    const events: ReturnType<HeartbeatMonitor['getEvents']> = [];
    const monitor = new HeartbeatMonitor({
      polecatStallThresholdMs: HARD_MS,
      earlyEscalationThresholdMs: EARLY_MS,
      onEvent: (e) => events.push(e),
    });

    monitor.registerWaitingBead('resolved-bead', 10, false);
    monitor.unregisterBead('resolved-bead');

    const tracked = (monitor as unknown as { trackedBeads: Map<string, unknown> }).trackedBeads;
    expect(tracked.has('resolved-bead')).toBe(false);

    // Poll should not emit anything for this bead
    monitor.checkOnce();
    expect(events.length).toBe(0);
  });
});

describe('HeartbeatMonitor — KG metadata class enforcement', () => {
  it('KG rejects locked_to write without metadata.class', async () => {
    const { KnowledgeGraph } = await import('../../src/kg/index');
    const kg = new KnowledgeGraph(':memory:');

    expect(() => kg.addTriple({
      subject: 'some-model',
      relation: 'locked_to',
      object: 'some-task',
      valid_from: '2026-04-01',
      agent_id: 'historian',
      metadata: {},  // missing class
      created_at: new Date().toISOString(),
    })).toThrow(/requires metadata\.class/);

    kg.close();
  });

  it('KG accepts locked_to with metadata.class = critical', async () => {
    const { KnowledgeGraph } = await import('../../src/kg/index');
    const kg = new KnowledgeGraph(':memory:');

    expect(() => kg.addTriple({
      subject: 'some-model',
      relation: 'locked_to',
      object: 'some-task',
      valid_from: '2026-04-01',
      agent_id: 'historian',
      metadata: { class: 'critical' },
      created_at: new Date().toISOString(),
    })).not.toThrow();

    kg.close();
  });

  it('KG does not enforce class on non-critical relations', async () => {
    const { KnowledgeGraph } = await import('../../src/kg/index');
    const kg = new KnowledgeGraph(':memory:');

    expect(() => kg.addTriple({
      subject: 'subject',
      relation: 'part_of',   // advisory relation — no class required
      object: 'object',
      valid_from: '2026-04-01',
      agent_id: 'test',
      metadata: {},
      created_at: new Date().toISOString(),
    })).not.toThrow();

    kg.close();
  });
});

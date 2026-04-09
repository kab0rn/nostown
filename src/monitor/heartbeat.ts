// NOS Town — Heartbeat Monitor
// Detects Polecat stalls, Mayor heartbeat gaps, and swarm deadlocks.
// Per SWARM.md §2.1: escalates early (5min) when fan_out >= 10, sole predecessor,
// or starvation (bypass count >= 3) — not just the 15-minute hard timeout.

import type { HeartbeatEvent } from '../types/index.js';
import type { Polecat } from '../roles/polecat.js';
import type { Mayor } from '../roles/mayor.js';
import {
  mayorHeartbeatGapMs,
  polecatStallRate,
  criticalBeadStarvation,
  orphanWorkflowCount,
} from '../telemetry/metrics.js';

export type HeartbeatHandler = (event: HeartbeatEvent) => void;

export interface HeartbeatMonitorConfig {
  polecatStallThresholdMs?: number;    // default: 15min (SWARM.md hard timeout)
  earlyEscalationThresholdMs?: number; // default: 5min (for high fan-out / sole-predecessor)
  mayorMissingThresholdMs?: number;    // default: 2× heartbeat interval
  pollIntervalMs?: number;             // default: 30s
  onEvent?: HeartbeatHandler;
}

interface TrackedPolecat {
  agentId: string;
  instance: Polecat;
}

/** Swarm bead metadata for deadlock heuristics (SWARM.md §2.1) */
export interface TrackedBead {
  beadId: string;
  fanOutWeight: number;
  isSolePredecessor: boolean;
  bypassCount: number;
  waitingStart: Date;
  earlyEscalated: boolean;
  hardEscalated: boolean;
}

export class HeartbeatMonitor {
  private polecats: TrackedPolecat[] = [];
  private mayor: Mayor | null = null;
  private mayorHeartbeatIntervalMs: number;

  private stallThresholdMs: number;
  private earlyEscalationThresholdMs: number;
  private mayorMissingThresholdMs: number;
  private pollIntervalMs: number;
  private onEvent: HeartbeatHandler | null;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private events: HeartbeatEvent[] = [];

  /** Swarm beads under active deadlock monitoring */
  private trackedBeads = new Map<string, TrackedBead>();

  constructor(config: HeartbeatMonitorConfig = {}) {
    this.stallThresholdMs = config.polecatStallThresholdMs ?? 15 * 60 * 1000;
    this.earlyEscalationThresholdMs = config.earlyEscalationThresholdMs ?? 5 * 60 * 1000;
    this.mayorMissingThresholdMs = config.mayorMissingThresholdMs ?? 2 * 60 * 1000;
    this.pollIntervalMs = config.pollIntervalMs ?? 30_000;
    this.onEvent = config.onEvent ?? null;
    this.mayorHeartbeatIntervalMs = 60_000;

    // Wire observable gauges (OBSERVABILITY.md §1)
    mayorHeartbeatGapMs.addCallback((result) => {
      if (this.mayor) {
        result.observe(Date.now() - this.mayor.lastHeartbeat.getTime());
      }
    });

    polecatStallRate.addCallback((result) => {
      if (this.polecats.length === 0) return;
      const now = Date.now();
      const stalled = this.polecats.filter(
        ({ instance }) =>
          instance.currentBeadId !== null &&
          now - instance.lastActivity.getTime() > this.stallThresholdMs,
      ).length;
      result.observe(stalled / this.polecats.length);
    });

    // orphan_workflow_count: tracked beads still waiting with no active Mayor
    // Per OBSERVABILITY.md: alert > 0 (workflows with active beads but no Mayor heartbeat)
    orphanWorkflowCount.addCallback((result) => {
      if (this.trackedBeads.size === 0) {
        result.observe(0);
        return;
      }
      const mayorMissing =
        this.mayor === null ||
        Date.now() - this.mayor.lastHeartbeat.getTime() > this.mayorMissingThresholdMs;
      result.observe(mayorMissing ? this.trackedBeads.size : 0);
    });
  }

  registerPolecat(agentId: string, instance: Polecat): void {
    this.polecats.push({ agentId, instance });
  }

  registerMayor(instance: Mayor, heartbeatIntervalMs = 60_000): void {
    this.mayor = instance;
    this.mayorHeartbeatIntervalMs = heartbeatIntervalMs;
    this.mayorMissingThresholdMs = 2 * heartbeatIntervalMs;
  }

  /**
   * Register a waiting bead for deadlock heuristic tracking.
   * Call when a bead enters WAITING state (blocked on prerequisites).
   * Per SWARM.md §2.1: monitors fan_out_weight and sole-predecessor status.
   */
  registerWaitingBead(
    beadId: string,
    fanOutWeight: number,
    isSolePredecessor: boolean,
  ): void {
    this.trackedBeads.set(beadId, {
      beadId,
      fanOutWeight,
      isSolePredecessor,
      bypassCount: 0,
      waitingStart: new Date(),
      earlyEscalated: false,
      hardEscalated: false,
    });
  }

  /**
   * Record that a bead was bypassed by lower-priority work.
   * Per SWARM.md §2.1: triggers STARVATION escalation after 3 bypasses.
   */
  recordBypass(beadId: string): void {
    const bead = this.trackedBeads.get(beadId);
    if (!bead) return;
    bead.bypassCount++;
    if (bead.bypassCount >= 3 && !bead.earlyEscalated) {
      bead.earlyEscalated = true;
      criticalBeadStarvation.add(1, { bead_id: beadId });
      this.emit({
        type: 'POTENTIAL_DEADLOCK',
        bead_id: beadId,
        stall_duration_ms: Date.now() - bead.waitingStart.getTime(),
        reason: 'STARVATION',
      });
    }
  }

  /** Unregister a bead once it resolves. */
  unregisterBead(beadId: string): void {
    this.trackedBeads.delete(beadId);
  }

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private poll(): void {
    const now = new Date();

    // ── Polecat stall detection (15-min hard threshold) ──────────────────────
    for (const { agentId, instance } of this.polecats) {
      const lastActivity = instance.lastActivity;
      const stalledMs = now.getTime() - lastActivity.getTime();
      const beadId = instance.currentBeadId;

      if (beadId && stalledMs > this.stallThresholdMs) {
        this.emit({
          type: 'POLECAT_STALLED',
          bead_id: beadId,
          agent_id: agentId,
          stall_duration_ms: stalledMs,
        });
      }
    }

    // ── Mayor heartbeat check ─────────────────────────────────────────────────
    if (this.mayor) {
      const missingMs = now.getTime() - this.mayor.lastHeartbeat.getTime();
      if (missingMs > this.mayorMissingThresholdMs) {
        this.emit({
          type: 'MAYOR_MISSING',
          last_seen_at: this.mayor.lastHeartbeat.toISOString(),
          active_convoy_id: 'unknown',
        });
      }
    }

    // ── Swarm deadlock early escalation (SWARM.md §2.1) ──────────────────────
    // Escalate before 15 min when:
    //   fan_out_weight >= 10  →  HIGH_FAN_OUT at 5min
    //   sole predecessor of rendezvous node  →  SOLE_PREDECESSOR at 5min
    //   bypassed 3+ times  →  handled in recordBypass() above
    for (const bead of this.trackedBeads.values()) {
      if (bead.earlyEscalated || bead.hardEscalated) continue;

      const waitMs = now.getTime() - bead.waitingStart.getTime();
      const isHighFanOut = bead.fanOutWeight >= 10;
      const isSolePred = bead.isSolePredecessor;

      if ((isHighFanOut || isSolePred) && waitMs > this.earlyEscalationThresholdMs) {
        bead.earlyEscalated = true;
        this.emit({
          type: 'POTENTIAL_DEADLOCK',
          bead_id: bead.beadId,
          stall_duration_ms: waitMs,
          reason: isHighFanOut ? 'HIGH_FAN_OUT' : 'SOLE_PREDECESSOR',
        });
      } else if (waitMs > this.stallThresholdMs) {
        bead.hardEscalated = true;
        this.emit({
          type: 'POTENTIAL_DEADLOCK',
          bead_id: bead.beadId,
          stall_duration_ms: waitMs,
          reason: 'HIGH_FAN_OUT', // generic: exceeded hard timeout
        });
      }
    }
  }

  private emit(event: HeartbeatEvent): void {
    this.events.push(event);
    this.onEvent?.(event);
    console.warn(`[HeartbeatMonitor] ${event.type}:`, JSON.stringify(event));
  }

  getEvents(): HeartbeatEvent[] {
    return [...this.events];
  }

  clearEvents(): void {
    this.events = [];
  }

  /**
   * Run a single check cycle (useful for testing without timers).
   */
  checkOnce(): HeartbeatEvent[] {
    const before = this.events.length;
    this.poll();
    return this.events.slice(before);
  }
}

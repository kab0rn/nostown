// NOS Town — Heartbeat Monitor

import type { HeartbeatEvent } from '../types/index.js';
import type { Polecat } from '../roles/polecat.js';
import type { Mayor } from '../roles/mayor.js';

export type HeartbeatHandler = (event: HeartbeatEvent) => void;

export interface HeartbeatMonitorConfig {
  polecatStallThresholdMs?: number;   // default: 10min
  mayorMissingThresholdMs?: number;   // default: 2x heartbeat interval
  pollIntervalMs?: number;            // default: 30s
  onEvent?: HeartbeatHandler;
}

interface TrackedPolecat {
  agentId: string;
  instance: Polecat;
}

export class HeartbeatMonitor {
  private polecats: TrackedPolecat[] = [];
  private mayor: Mayor | null = null;
  private mayorHeartbeatIntervalMs: number;

  private stallThresholdMs: number;
  private mayorMissingThresholdMs: number;
  private pollIntervalMs: number;
  private onEvent: HeartbeatHandler | null;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private events: HeartbeatEvent[] = [];

  constructor(config: HeartbeatMonitorConfig = {}) {
    this.stallThresholdMs = config.polecatStallThresholdMs ?? 10 * 60 * 1000;
    this.mayorMissingThresholdMs = config.mayorMissingThresholdMs ?? 2 * 60 * 1000;
    this.pollIntervalMs = config.pollIntervalMs ?? 30_000;
    this.onEvent = config.onEvent ?? null;
    this.mayorHeartbeatIntervalMs = 60_000; // default
  }

  registerPolecat(agentId: string, instance: Polecat): void {
    this.polecats.push({ agentId, instance });
  }

  registerMayor(instance: Mayor, heartbeatIntervalMs = 60_000): void {
    this.mayor = instance;
    this.mayorHeartbeatIntervalMs = heartbeatIntervalMs;
    this.mayorMissingThresholdMs = 2 * heartbeatIntervalMs;
  }

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    console.log(`[HeartbeatMonitor] Started polling every ${this.pollIntervalMs}ms`);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private poll(): void {
    const now = new Date();

    // Check each polecat for stalls
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

    // Check Mayor heartbeat
    if (this.mayor) {
      const lastHeartbeat = this.mayor.lastHeartbeat;
      const missingMs = now.getTime() - lastHeartbeat.getTime();

      if (missingMs > this.mayorMissingThresholdMs) {
        this.emit({
          type: 'MAYOR_MISSING',
          last_seen_at: lastHeartbeat.toISOString(),
          active_convoy_id: 'unknown',
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
   * Run a single check cycle (useful for testing)
   */
  checkOnce(): HeartbeatEvent[] {
    const before = this.events.length;
    this.poll();
    return this.events.slice(before);
  }
}

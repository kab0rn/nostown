// NOS Town — Swarm Coordinator

import type { Bead } from '../types/index.js';

const EARLY_DEADLOCK_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const HIGH_FAN_OUT_WEIGHT = 10;

export interface DispatchQueue {
  bead: Bead;
  priority_score: number;
}

export interface CoordinatorConfig {
  onEscalate?: (reason: string, beads: Bead[]) => void;
}

export class SwarmCoordinator {
  private onEscalate: ((reason: string, beads: Bead[]) => void) | null;
  private pendingBeads: Map<string, Bead> = new Map();
  private completedBeads: Set<string> = new Set();
  private dispatchStartTimes: Map<string, Date> = new Map();

  constructor(config: CoordinatorConfig = {}) {
    this.onEscalate = config.onEscalate ?? null;
  }

  /**
   * Topological sort of beads by dependency order.
   * Returns sorted array (roots first) or throws if cycles detected.
   */
  topologicalSort(beads: Bead[]): Bead[] {
    if (beads.length === 0) return [];

    // Build adjacency and in-degree maps
    const beadMap = new Map(beads.map((b) => [b.bead_id, b]));
    const inDegree = new Map(beads.map((b) => [b.bead_id, 0]));
    const dependents = new Map<string, string[]>(); // bead → beads that depend on it

    for (const bead of beads) {
      dependents.set(bead.bead_id, []);
    }

    for (const bead of beads) {
      for (const needId of bead.needs) {
        if (!beadMap.has(needId)) continue; // external dependency
        const current = inDegree.get(bead.bead_id) ?? 0;
        inDegree.set(bead.bead_id, current + 1);
        dependents.get(needId)?.push(bead.bead_id);
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    const sorted: Bead[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const bead = beadMap.get(id);
      if (bead) sorted.push(bead);

      for (const depId of (dependents.get(id) ?? [])) {
        const newDeg = (inDegree.get(depId) ?? 0) - 1;
        inDegree.set(depId, newDeg);
        if (newDeg === 0) queue.push(depId);
      }
    }

    if (sorted.length !== beads.length) {
      const cycleBeads = beads.filter((b) => !sorted.find((s) => s.bead_id === b.bead_id));
      throw new Error(`Cycle detected in bead dependency graph: ${cycleBeads.map((b) => b.bead_id).join(', ')}`);
    }

    return sorted;
  }

  /**
   * Detect if any cycles exist (returns list of bead IDs in cycles)
   */
  detectCycles(beads: Bead[]): string[] {
    try {
      this.topologicalSort(beads);
      return [];
    } catch (err) {
      const msg = String(err);
      const match = msg.match(/Cycle detected.*?: (.+)$/);
      return match ? match[1].split(', ') : [];
    }
  }

  /**
   * Priority score for dispatch ordering:
   * critical_path=true (+1000) > fan_out_weight (+weight) > priority string (+100/50/10) > FIFO (+0)
   */
  private priorityScore(bead: Bead, index: number): number {
    let score = 0;
    if (bead.critical_path) score += 1000;
    score += (bead.fan_out_weight ?? 1) * 10;
    // priority field is not in Bead type — use fan_out as proxy
    return score - index * 0.001; // FIFO tiebreaker
  }

  /**
   * Dispatch beads in priority order, respecting dependencies.
   */
  async dispatchWithPriority(
    beads: Bead[],
    dispatcher: (bead: Bead) => Promise<void>,
  ): Promise<void> {
    // Sort topologically first
    const sorted = this.topologicalSort(beads);

    // Build priority queue
    const queue: DispatchQueue[] = sorted.map((bead, i) => ({
      bead,
      priority_score: this.priorityScore(bead, i),
    }));

    // Sort by priority score descending
    queue.sort((a, b) => b.priority_score - a.priority_score);

    for (const { bead } of queue) {
      // Wait for prerequisites
      const prereqsSatisfied = bead.needs.every((id) => this.completedBeads.has(id));
      if (!prereqsSatisfied) {
        // Check for early deadlock
        const startTime = this.dispatchStartTimes.get(bead.bead_id);
        if (startTime) {
          const waitMs = Date.now() - startTime.getTime();
          if (waitMs > EARLY_DEADLOCK_THRESHOLD_MS && (bead.fan_out_weight ?? 1) >= HIGH_FAN_OUT_WEIGHT) {
            this.earlyDeadlockEscalation(bead, beads);
          }
        } else {
          this.dispatchStartTimes.set(bead.bead_id, new Date());
        }
        continue;
      }

      try {
        await dispatcher(bead);
        this.completedBeads.add(bead.bead_id);
      } catch (err) {
        console.error(`[SwarmCoordinator] Dispatch failed for ${bead.bead_id}: ${String(err)}`);
      }
    }
  }

  /**
   * Escalate before 15min if fan_out_weight >= 10 and dependencies are unresolved.
   */
  earlyDeadlockEscalation(stalledBead: Bead, allBeads: Bead[]): void {
    const blockers = stalledBead.needs.filter((id) => !this.completedBeads.has(id));
    const blockerBeads = allBeads.filter((b) => blockers.includes(b.bead_id));

    const reason = `Early deadlock: bead ${stalledBead.bead_id} (fan_out_weight=${stalledBead.fan_out_weight}) blocked by: ${blockers.join(', ')}`;
    console.error(`[SwarmCoordinator] ${reason}`);
    this.onEscalate?.(reason, [stalledBead, ...blockerBeads]);
  }

  /**
   * Mark a bead as completed (called after successful execution)
   */
  markCompleted(beadId: string): void {
    this.completedBeads.add(beadId);
    this.dispatchStartTimes.delete(beadId);
  }

  /**
   * Get beads that are ready to dispatch (all prerequisites satisfied)
   */
  getReadyBeads(beads: Bead[]): Bead[] {
    return beads.filter((b) =>
      b.status === 'pending' &&
      b.needs.every((id) => this.completedBeads.has(id)),
    );
  }

  reset(): void {
    this.pendingBeads.clear();
    this.completedBeads.clear();
    this.dispatchStartTimes.clear();
  }
}

// NOS Town — KG Sync Monitor
//
// Polls KnowledgeGraph.computeStateHash() on a configurable interval and fires
// an onStateChange callback whenever the hash changes. This lets agents detect
// KG writes made by other processes without taking an explicit lock.
//
// Per KNOWLEDGE_GRAPH.md §Consistency Model.

import type { KnowledgeGraph } from './index.js';

export class KGSyncMonitor {
  private readonly kg: KnowledgeGraph;
  private readonly intervalMs: number;
  private readonly onStateChange: ((hash: string) => void) | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHash = '';

  constructor(
    kg: KnowledgeGraph,
    intervalMs = 500,
    onStateChange?: (hash: string) => void,
  ) {
    this.kg = kg;
    this.intervalMs = intervalMs;
    this.onStateChange = onStateChange ?? null;
  }

  start(): void {
    if (this.timer) return;
    // Initialize lastHash to current state so we only fire on actual changes
    this.lastHash = this.kg.computeStateHash();
    this.timer = setInterval(() => {
      const hash = this.kg.computeStateHash();
      if (hash !== this.lastHash) {
        this.lastHash = hash;
        this.onStateChange?.(hash);
      }
    }, this.intervalMs);
    // Do not keep the process alive just because the monitor is running
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  currentHash(): string {
    return this.lastHash;
  }
}

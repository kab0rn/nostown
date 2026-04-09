// NOS Town — MemPalace Mode B: Queued Write Front Door
// Per MEMPALACE.md §Mode B:
//   - All write operations pass through a local bounded queue
//   - Vector writes (addDrawer) and KG writes are decoupled
//   - Queue metrics exported to observability
//   - Promotes from Mode A when p95 write latency exceeds thresholds

import type { MemPalaceClient } from './client.js';

export interface WriteOp {
  type: 'addDrawer' | 'diaryWrite' | 'saveCheckpoint';
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
}

export interface WriteQueueConfig {
  /** Maximum number of pending write ops before new writes block (default: 200) */
  maxDepth?: number;
  /** Flush interval in ms — ops are processed at most this often (default: 10ms) */
  flushIntervalMs?: number;
  /** Concurrency limit — max simultaneous in-flight writes (default: 4) */
  concurrency?: number;
}

export interface WriteQueueMetrics {
  enqueued: number;
  completed: number;
  failed: number;
  dropped: number;
  queueDepth: number;
  p95LatencyMs: number;
}

/**
 * MemPalace write queue (Mode B front door).
 * Buffers all write operations, processes them with bounded concurrency,
 * exports latency metrics for observability.
 */
export class MemPalaceWriteQueue {
  private client: MemPalaceClient;
  private maxDepth: number;
  private concurrency: number;

  private queue: WriteOp[] = [];
  private inFlight = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  // Metrics
  private _enqueued = 0;
  private _completed = 0;
  private _failed = 0;
  private _dropped = 0;
  private _latencies: number[] = [];

  constructor(client: MemPalaceClient, config: WriteQueueConfig = {}) {
    this.client = client;
    this.maxDepth = config.maxDepth ?? 200;
    this.concurrency = config.concurrency ?? 4;

    const flushInterval = config.flushIntervalMs ?? 10;
    this.timer = setInterval(() => void this.flush(), flushInterval);
  }

  /**
   * Enqueue an addDrawer write.
   * Returns a promise that resolves when the write completes.
   */
  addDrawer(wing: string, hall: string, room: string, content: string, keywords?: string): Promise<{ id: string }> {
    return this.enqueue('addDrawer', [wing, hall, room, content, keywords]) as Promise<{ id: string }>;
  }

  /**
   * Enqueue a diaryWrite.
   */
  diaryWrite(wing: string, content: string): Promise<{ id: number }> {
    return this.enqueue('diaryWrite', [wing, content]) as Promise<{ id: number }>;
  }

  /**
   * Enqueue a saveCheckpoint.
   */
  saveCheckpoint(agentId: string, plan: Record<string, unknown>, beadIds: string[]): Promise<string> {
    return this.enqueue('saveCheckpoint', [agentId, plan, beadIds]) as Promise<string>;
  }

  private enqueue(type: WriteOp['type'], args: unknown[]): Promise<unknown> {
    if (this.queue.length >= this.maxDepth) {
      this._dropped++;
      return Promise.reject(new Error(`MemPalaceWriteQueue: queue full (depth=${this.maxDepth})`));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        type,
        args,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });
      this._enqueued++;
    });
  }

  private async flush(): Promise<void> {
    while (this.queue.length > 0 && this.inFlight < this.concurrency) {
      const op = this.queue.shift();
      if (!op) break;

      this.inFlight++;
      void this.executeOp(op).finally(() => { this.inFlight--; });
    }
  }

  private async executeOp(op: WriteOp): Promise<void> {
    const startMs = Date.now();
    try {
      let result: unknown;
      if (op.type === 'addDrawer') {
        const [wing, hall, room, content, keywords] = op.args as [string, string, string, string, string?];
        result = await this.client.addDrawer(wing, hall, room, content, keywords);
      } else if (op.type === 'diaryWrite') {
        const [wing, content] = op.args as [string, string];
        result = await this.client.diaryWrite(wing, content);
      } else if (op.type === 'saveCheckpoint') {
        const [agentId, plan, beadIds] = op.args as [string, Record<string, unknown>, string[]];
        result = await this.client.saveCheckpoint(agentId, plan, beadIds);
      }

      const latencyMs = Date.now() - startMs;
      this._latencies.push(latencyMs);
      if (this._latencies.length > 1000) this._latencies.shift(); // rolling window
      this._completed++;
      op.resolve(result);
    } catch (err) {
      this._failed++;
      op.reject(err);
    }
  }

  get metrics(): WriteQueueMetrics {
    const sorted = [...this._latencies].sort((a, b) => a - b);
    const p95Idx = Math.floor(sorted.length * 0.95);
    return {
      enqueued: this._enqueued,
      completed: this._completed,
      failed: this._failed,
      dropped: this._dropped,
      queueDepth: this.queue.length,
      p95LatencyMs: sorted[p95Idx] ?? 0,
    };
  }

  /**
   * Drain all pending operations and stop the flush timer.
   * Waits for all queued and in-flight writes to complete.
   */
  async drain(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Keep flushing until queue is empty and no ops are in-flight
    while (this.queue.length > 0 || this.inFlight > 0) {
      await this.flush();
      if (this.queue.length > 0 || this.inFlight > 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
  }

  /**
   * Stop the queue immediately (no drain). Pending ops are rejected.
   */
  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const remaining = this.queue.splice(0);
    for (const op of remaining) {
      op.reject(new Error('MemPalaceWriteQueue closed'));
    }
  }
}

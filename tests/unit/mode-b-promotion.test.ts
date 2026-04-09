// Tests: MemPalace Mode B auto-promotion thresholds (MEMPALACE.md §Promotion Criteria)

import { shouldPromoteToModeB, MODE_B_THRESHOLDS, MemPalaceWriteQueue } from '../../src/mempalace/write-queue';
import { MemPalaceClient } from '../../src/mempalace/client';

describe('shouldPromoteToModeB() — promotion criteria (MEMPALACE.md)', () => {
  it('returns false when all metrics are below thresholds', () => {
    expect(shouldPromoteToModeB({
      p95KgWriteLatencyMs: 10,
      p95AddDrawerLatencyMs: 50,
      concurrentWriters: 3,
    })).toBe(false);
  });

  it('returns true when p95 KG write latency exceeds 50ms', () => {
    expect(shouldPromoteToModeB({ p95KgWriteLatencyMs: 51 })).toBe(true);
  });

  it('returns true when p95 addDrawer latency exceeds 150ms', () => {
    expect(shouldPromoteToModeB({ p95AddDrawerLatencyMs: 151 })).toBe(true);
  });

  it('returns true when concurrent writers exceed 10', () => {
    expect(shouldPromoteToModeB({ concurrentWriters: 11 })).toBe(true);
  });

  it('returns false at exact threshold boundaries (not strictly exceeded)', () => {
    expect(shouldPromoteToModeB({
      p95KgWriteLatencyMs: MODE_B_THRESHOLDS.p95KgWriteLatencyMs,
      p95AddDrawerLatencyMs: MODE_B_THRESHOLDS.p95AddDrawerLatencyMs,
      concurrentWriters: MODE_B_THRESHOLDS.maxConcurrentWriters,
    })).toBe(false);
  });

  it('returns false with no arguments (all undefined = 0)', () => {
    expect(shouldPromoteToModeB({})).toBe(false);
  });
});

describe('WriteQueueMetrics.promotionAdvisory', () => {
  it('is false when p95 latency is within threshold', async () => {
    const client = new MemPalaceClient('http://localhost:9999');
    jest.spyOn(client, 'addDrawer').mockResolvedValue({ id: 'ok' });

    const q = new MemPalaceWriteQueue(client, { flushIntervalMs: 5 });
    await q.addDrawer('w', 'h', 'r', 'c');
    await q.drain();

    // Fast mock = low latency = no advisory
    expect(q.metrics.promotionAdvisory).toBe(false);
  });

  it('is true when p95 latency exceeds 150ms', async () => {
    const client = new MemPalaceClient('http://localhost:9999');
    jest.spyOn(client, 'addDrawer').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 160)); // 160ms > 150ms threshold
      return { id: 'slow' };
    });

    const q = new MemPalaceWriteQueue(client, { flushIntervalMs: 5, concurrency: 4 });
    // Need enough samples for a meaningful p95
    const writes = Array.from({ length: 20 }, (_, i) =>
      q.addDrawer('w', 'h', `r${i}`, 'c'),
    );
    await Promise.all(writes);
    await q.drain();

    expect(q.metrics.p95LatencyMs).toBeGreaterThan(150);
    expect(q.metrics.promotionAdvisory).toBe(true);
  }, 10000);

  it('exports promotionAdvisory in metrics object', async () => {
    const client = new MemPalaceClient('http://localhost:9999');
    jest.spyOn(client, 'addDrawer').mockResolvedValue({ id: 'ok' });

    const q = new MemPalaceWriteQueue(client, { flushIntervalMs: 5 });
    const m = q.metrics;

    expect(m).toHaveProperty('promotionAdvisory');
    expect(typeof m.promotionAdvisory).toBe('boolean');
    q.close();
  });
});

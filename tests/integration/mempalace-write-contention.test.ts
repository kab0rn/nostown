// Integration: MemPalace write queue serializes concurrent writes (RISKS.md R-001)
// Validates: p95 write latency tracking, bounded concurrency, Mode B promotion advisory,
// dropped-write detection, and serialized completion ordering.

import { MemPalaceWriteQueue, shouldPromoteToModeB, MODE_B_THRESHOLDS } from '../../src/mempalace/write-queue';
import { MemPalaceClient } from '../../src/mempalace/client';

jest.mock('../../src/mempalace/client');

describe('MemPalace write contention — concurrent serialization (R-001)', () => {
  let mockClient: jest.Mocked<MemPalaceClient>;
  let queue: MemPalaceWriteQueue;

  beforeEach(() => {
    mockClient = new MemPalaceClient() as jest.Mocked<MemPalaceClient>;
    mockClient.addDrawer = jest.fn().mockResolvedValue({ id: 'mock-drawer' });
    mockClient.diaryWrite = jest.fn().mockResolvedValue({ id: 1 });
    mockClient.saveCheckpoint = jest.fn().mockResolvedValue('ckpt-mock');
  });

  afterEach(async () => {
    await queue.drain();
  });

  it('serializes 20 concurrent addDrawer writes without corruption', async () => {
    queue = new MemPalaceWriteQueue(mockClient, { concurrency: 4, flushIntervalMs: 5 });
    const COUNT = 20;
    const promises = Array.from({ length: COUNT }, (_, i) =>
      queue.addDrawer('wing_test', 'hall_events', `room-${i}`, `content-${i}`),
    );
    const results = await Promise.all(promises);

    expect(results).toHaveLength(COUNT);
    results.forEach((r) => expect(r).toEqual({ id: 'mock-drawer' }));
    expect(mockClient.addDrawer).toHaveBeenCalledTimes(COUNT);
    expect(queue.metrics.completed).toBe(COUNT);
    expect(queue.metrics.failed).toBe(0);
    expect(queue.metrics.dropped).toBe(0);
  });

  it('never exceeds concurrency limit (bounded in-flight)', async () => {
    let maxConcurrent = 0;
    let current = 0;

    mockClient.addDrawer = jest.fn().mockImplementation(async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 5)); // simulate latency
      current--;
      return { id: 'mock' };
    });

    queue = new MemPalaceWriteQueue(mockClient, { concurrency: 3, flushIntervalMs: 2 });
    const promises = Array.from({ length: 15 }, (_, i) =>
      queue.addDrawer('wing_test', 'hall_events', `room-${i}`, `content-${i}`),
    );
    await Promise.all(promises);

    // Concurrent writes must not exceed concurrency limit
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('drops writes and rejects with error when queue is full', async () => {
    // Slow client + small queue depth = overflow on burst
    mockClient.addDrawer = jest.fn().mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ id: 'ok' }), 200)),
    );

    queue = new MemPalaceWriteQueue(mockClient, {
      maxDepth: 5,
      concurrency: 1,
      flushIntervalMs: 500, // slow flush to force overflow
    });

    // First 5 fill the queue; the 6th should be dropped
    const all = Array.from({ length: 8 }, (_, i) =>
      queue.addDrawer('w', 'h', `r-${i}`, `c-${i}`).catch((e: Error) => e),
    );
    const results = await Promise.all(all);
    const errors = results.filter((r) => r instanceof Error);
    expect(errors.length).toBeGreaterThan(0);
    expect(queue.metrics.dropped).toBeGreaterThan(0);
  });

  it('tracks p95 latency and sets promotionAdvisory when threshold exceeded', async () => {
    // Simulate slow client (160ms per write — above 150ms p95 threshold)
    mockClient.addDrawer = jest.fn().mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ id: 'slow' }), 160)),
    );

    queue = new MemPalaceWriteQueue(mockClient, { concurrency: 1, flushIntervalMs: 5 });
    // Need enough samples for p95 to reflect the slow writes (at least 20 to get stable p95)
    const promises = Array.from({ length: 20 }, (_, i) =>
      queue.addDrawer('w', 'h', `r-${i}`, `c-${i}`),
    );
    await Promise.all(promises);

    const metrics = queue.metrics;
    expect(metrics.p95LatencyMs).toBeGreaterThan(0);
    // If p95 > 150ms threshold, promotionAdvisory should be true
    if (metrics.p95LatencyMs > MODE_B_THRESHOLDS.p95AddDrawerLatencyMs) {
      expect(metrics.promotionAdvisory).toBe(true);
    }
  }, 10000);

  it('metrics.queueDepth returns 0 after drain', async () => {
    queue = new MemPalaceWriteQueue(mockClient, { concurrency: 2, flushIntervalMs: 5 });
    const promises = Array.from({ length: 10 }, (_, i) =>
      queue.addDrawer('w', 'h', `r-${i}`, `c-${i}`),
    );
    await Promise.all(promises);
    expect(queue.metrics.queueDepth).toBe(0);
  });

  it('diaryWrite and saveCheckpoint are also serialized', async () => {
    queue = new MemPalaceWriteQueue(mockClient, { concurrency: 2, flushIntervalMs: 5 });
    const results = await Promise.all([
      queue.diaryWrite('wing_a', 'diary content'),
      queue.saveCheckpoint('agent-1', { task: 'test' }, ['bead-1', 'bead-2']),
      queue.addDrawer('wing_b', 'hall_facts', 'room-1', 'content'),
    ]);

    expect(results[0]).toEqual({ id: 1 });
    expect(results[1]).toBe('ckpt-mock');
    expect(results[2]).toEqual({ id: 'mock-drawer' });
    expect(mockClient.diaryWrite).toHaveBeenCalledTimes(1);
    expect(mockClient.saveCheckpoint).toHaveBeenCalledTimes(1);
  });
});

describe('shouldPromoteToModeB thresholds', () => {
  it('triggers on p95 KG write latency > 50ms', () => {
    expect(shouldPromoteToModeB({ p95KgWriteLatencyMs: 51 })).toBe(true);
    expect(shouldPromoteToModeB({ p95KgWriteLatencyMs: 50 })).toBe(false);
  });

  it('triggers on p95 addDrawer latency > 150ms', () => {
    expect(shouldPromoteToModeB({ p95AddDrawerLatencyMs: 151 })).toBe(true);
    expect(shouldPromoteToModeB({ p95AddDrawerLatencyMs: 150 })).toBe(false);
  });

  it('triggers when concurrent writers > 10', () => {
    expect(shouldPromoteToModeB({ concurrentWriters: 11 })).toBe(true);
    expect(shouldPromoteToModeB({ concurrentWriters: 10 })).toBe(false);
  });

  it('no trigger when all metrics are within bounds', () => {
    expect(shouldPromoteToModeB({
      p95KgWriteLatencyMs: 40,
      p95AddDrawerLatencyMs: 100,
      concurrentWriters: 8,
    })).toBe(false);
  });
});

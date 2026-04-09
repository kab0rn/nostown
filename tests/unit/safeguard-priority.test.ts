// Tests for SafeguardPool priority queue and queue depth metric

import { jest } from '@jest/globals';
import { SafeguardPool, SafeguardWorker } from '../../src/roles/safeguard.js';

describe('SafeguardPool priority queue', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('queueDepth is 0 when pool is idle', () => {
    const pool = new SafeguardPool({ poolSize: 2 });
    expect(pool.queueDepth).toBe(0);
  });

  test('workerCount reflects pool size', () => {
    const pool = new SafeguardPool({ poolSize: 4 });
    expect(pool.workerCount).toBe(4);
  });

  test('queueDepth tracks pending scans when workers are saturated', async () => {
    const pool = new SafeguardPool({ poolSize: 2 });

    const scanOrder: string[] = [];
    let releaseAll!: () => void;
    const allRelease = new Promise<void>((r) => { releaseAll = r; });

    jest.spyOn(SafeguardWorker.prototype, 'scan').mockImplementation(async (diff: string) => {
      await allRelease;
      scanOrder.push(diff);
      return { approved: true, violations: [] };
    });

    // Start 2 scans to saturate both workers
    const p1 = pool.scan('d1');
    const p2 = pool.scan('d2');

    // Both workers now occupied — wait for them to pick up their work
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.queueDepth).toBe(0);

    // Queue 3 more (beyond the 2-worker capacity)
    const p3 = pool.scan('d3', 5);    // medium priority
    const p4 = pool.scan('d4', 10);   // high priority
    const p5 = pool.scan('d5', 1);    // low priority

    await new Promise((r) => setTimeout(r, 5));
    expect(pool.queueDepth).toBe(3);

    // Release all workers
    releaseAll();
    await Promise.all([p1, p2, p3, p4, p5]);

    expect(pool.queueDepth).toBe(0);
  });

  test('queued items are served in descending priority order', async () => {
    const pool = new SafeguardPool({ poolSize: 2 });

    const scanOrder: string[] = [];
    let releaseAll!: () => void;
    const allRelease = new Promise<void>((r) => { releaseAll = r; });

    jest.spyOn(SafeguardWorker.prototype, 'scan').mockImplementation(async (diff: string) => {
      await allRelease;
      scanOrder.push(diff);
      return { approved: true, violations: [] };
    });

    // Saturate both workers with low-priority baseline scans
    const p1 = pool.scan('baseline-1', 0);
    const p2 = pool.scan('baseline-2', 0);

    await new Promise((r) => setTimeout(r, 10));

    // Queue items out of priority order: low, high, medium
    const p3 = pool.scan('low', 1);
    const p4 = pool.scan('high', 10);
    const p5 = pool.scan('medium', 5);

    await new Promise((r) => setTimeout(r, 5));

    // Verify queue depth before release
    expect(pool.queueDepth).toBe(3);

    releaseAll();
    await Promise.all([p1, p2, p3, p4, p5]);

    // The queued items (after baseline) should be served in high→medium→low order
    // scanOrder = [baseline-1, baseline-2, high, medium, low] (approximately)
    // At minimum, 'high' must appear before 'medium' and 'low'
    const hiIdx = scanOrder.indexOf('high');
    const medIdx = scanOrder.indexOf('medium');
    const loIdx = scanOrder.indexOf('low');
    expect(hiIdx).toBeLessThan(medIdx);
    expect(hiIdx).toBeLessThan(loIdx);
    expect(medIdx).toBeLessThan(loIdx);
  });

  test('scan with default priority 0 works correctly', async () => {
    const pool = new SafeguardPool({ poolSize: 2 });

    jest.spyOn(SafeguardWorker.prototype, 'scan').mockResolvedValue({
      approved: true,
      violations: [],
    });

    const result = await pool.scan('clean diff');
    expect(result.approved).toBe(true);
    expect(pool.queueDepth).toBe(0);
  });
});

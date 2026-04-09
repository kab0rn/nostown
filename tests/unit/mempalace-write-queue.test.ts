// Tests: MemPalace Mode B write queue
// Per MEMPALACE.md §Mode B: bounded queue, concurrency limit, metrics, drain.

import { MemPalaceClient } from '../../src/mempalace/client';
import { MemPalaceWriteQueue } from '../../src/mempalace/write-queue';

// Suppress console noise
beforeAll(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
afterAll(() => jest.restoreAllMocks());

function makeClient() {
  const client = new MemPalaceClient('http://localhost:9999');
  jest.spyOn(client, 'addDrawer').mockResolvedValue({ id: 'drawer-ok' });
  jest.spyOn(client, 'diaryWrite').mockResolvedValue({ id: 1 });
  jest.spyOn(client, 'saveCheckpoint').mockResolvedValue('ckpt-ok');
  return client;
}

describe('MemPalaceWriteQueue — basic queuing', () => {
  it('addDrawer resolves with result from client', async () => {
    const client = makeClient();
    const q = new MemPalaceWriteQueue(client, { flushIntervalMs: 5 });

    const result = await q.addDrawer('wing', 'hall', 'room', 'content');
    expect(result).toEqual({ id: 'drawer-ok' });
    expect(client.addDrawer).toHaveBeenCalledTimes(1);

    await q.drain();
  });

  it('diaryWrite resolves with result from client', async () => {
    const client = makeClient();
    const q = new MemPalaceWriteQueue(client, { flushIntervalMs: 5 });

    const result = await q.diaryWrite('wing', 'entry content');
    expect(result).toEqual({ id: 1 });

    await q.drain();
  });

  it('saveCheckpoint resolves with checkpoint ID', async () => {
    const client = makeClient();
    const q = new MemPalaceWriteQueue(client, { flushIntervalMs: 5 });

    const result = await q.saveCheckpoint('agent-1', { plan: 'data' }, ['bead-1']);
    expect(result).toBe('ckpt-ok');

    await q.drain();
  });

  it('multiple writes complete in order', async () => {
    const client = makeClient();
    const completedOrder: number[] = [];

    let callCount = 0;
    jest.spyOn(client, 'addDrawer').mockImplementation(async () => {
      const i = ++callCount;
      completedOrder.push(i);
      return { id: `d-${i}` };
    });

    const q = new MemPalaceWriteQueue(client, { flushIntervalMs: 5, concurrency: 1 });

    const p1 = q.addDrawer('w', 'h', 'r1', 'c1');
    const p2 = q.addDrawer('w', 'h', 'r2', 'c2');
    const p3 = q.addDrawer('w', 'h', 'r3', 'c3');

    await Promise.all([p1, p2, p3]);

    expect(completedOrder).toEqual([1, 2, 3]);
    await q.drain();
  });
});

describe('MemPalaceWriteQueue — concurrency limit', () => {
  it('does not exceed concurrency limit', async () => {
    const client = makeClient();
    let maxConcurrent = 0;
    let concurrent = 0;

    jest.spyOn(client, 'addDrawer').mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      return { id: 'ok' };
    });

    const CONCURRENCY = 2;
    const q = new MemPalaceWriteQueue(client, {
      concurrency: CONCURRENCY,
      flushIntervalMs: 2,
    });

    const promises = Array.from({ length: 6 }, (_, i) =>
      q.addDrawer('w', 'h', `r${i}`, 'c'),
    );
    await Promise.all(promises);

    expect(maxConcurrent).toBeLessThanOrEqual(CONCURRENCY);
    await q.drain();
  });
});

describe('MemPalaceWriteQueue — bounded queue', () => {
  it('rejects writes when queue is full', async () => {
    const client = makeClient();
    // Block execution so queue fills up
    let unblock: () => void;
    const blocker = new Promise<void>((r) => { unblock = r; });
    jest.spyOn(client, 'addDrawer').mockImplementation(async () => {
      await blocker;
      return { id: 'ok' };
    });

    const q = new MemPalaceWriteQueue(client, {
      maxDepth: 2,
      flushIntervalMs: 5,
      concurrency: 1,
    });

    // These fill up to maxDepth
    const p1 = q.addDrawer('w', 'h', 'r1', 'c');
    const p2 = q.addDrawer('w', 'h', 'r2', 'c');
    // Wait for one to be picked up by concurrency slot
    await new Promise((r) => setTimeout(r, 20));
    // Queue should now be at 1 (1 in-flight, 1 pending); enqueue one more
    const p3 = q.addDrawer('w', 'h', 'r3', 'c');
    // This one should overflow
    await expect(q.addDrawer('w', 'h', 'overflow', 'c')).rejects.toThrow('queue full');

    // Unblock and cleanup
    unblock!();
    await Promise.allSettled([p1, p2, p3]);
    await q.drain();
  });

  it('tracks dropped count in metrics', async () => {
    const client = makeClient();
    jest.spyOn(client, 'addDrawer').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { id: 'ok' };
    });

    const q = new MemPalaceWriteQueue(client, { maxDepth: 1, flushIntervalMs: 5, concurrency: 1 });

    // First write goes to in-flight, second to queue, third overflows
    q.addDrawer('w', 'h', 'r1', 'c').catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    q.addDrawer('w', 'h', 'r2', 'c').catch(() => {});
    q.addDrawer('w', 'h', 'r3', 'c').catch(() => {}); // overflow

    await new Promise((r) => setTimeout(r, 10));
    expect(q.metrics.dropped).toBeGreaterThanOrEqual(1);

    q.close();
  });
});

describe('MemPalaceWriteQueue — metrics', () => {
  it('tracks enqueued, completed, failed counts', async () => {
    const client = makeClient();
    jest.spyOn(client, 'addDrawer')
      .mockResolvedValueOnce({ id: 'ok' })
      .mockResolvedValueOnce({ id: 'ok' })
      .mockRejectedValueOnce(new Error('write failed'));

    const q = new MemPalaceWriteQueue(client, { flushIntervalMs: 5 });

    await q.addDrawer('w', 'h', 'r1', 'c');
    await q.addDrawer('w', 'h', 'r2', 'c');
    await expect(q.addDrawer('w', 'h', 'r3', 'c')).rejects.toThrow('write failed');

    const m = q.metrics;
    expect(m.enqueued).toBe(3);
    expect(m.completed).toBe(2);
    expect(m.failed).toBe(1);

    await q.drain();
  });

  it('p95LatencyMs is 0 when no writes completed', () => {
    const client = makeClient();
    const q = new MemPalaceWriteQueue(client, { flushIntervalMs: 1000 });
    expect(q.metrics.p95LatencyMs).toBe(0);
    q.close();
  });

  it('p95LatencyMs reflects actual write latency', async () => {
    const client = makeClient();
    jest.spyOn(client, 'addDrawer').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { id: 'ok' };
    });

    const q = new MemPalaceWriteQueue(client, { flushIntervalMs: 2, concurrency: 4 });
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      q.addDrawer('w', 'h', `r${i}`, 'c'),
    ));

    expect(q.metrics.p95LatencyMs).toBeGreaterThan(0);
    await q.drain();
  });
});

describe('MemPalaceWriteQueue — drain and close', () => {
  it('drain waits for all pending writes to complete', async () => {
    const client = makeClient();
    const completed: number[] = [];

    jest.spyOn(client, 'addDrawer').mockImplementation(async (_, _hall, room) => {
      await new Promise((r) => setTimeout(r, 10));
      completed.push(parseInt(String(room).replace('r', ''), 10));
      return { id: 'ok' };
    });

    const q = new MemPalaceWriteQueue(client, { flushIntervalMs: 2, concurrency: 2 });
    q.addDrawer('w', 'h', 'r1', 'c').catch(() => {});
    q.addDrawer('w', 'h', 'r2', 'c').catch(() => {});
    q.addDrawer('w', 'h', 'r3', 'c').catch(() => {});

    await q.drain();

    expect(completed).toHaveLength(3);
  });

  it('close() rejects pending ops immediately', async () => {
    const client = makeClient();
    jest.spyOn(client, 'addDrawer').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { id: 'ok' };
    });

    const q = new MemPalaceWriteQueue(client, { flushIntervalMs: 50 });
    // Enqueue before flush fires
    const p = q.addDrawer('w', 'h', 'r', 'c');
    q.close();

    await expect(p).rejects.toThrow('closed');
  });
});

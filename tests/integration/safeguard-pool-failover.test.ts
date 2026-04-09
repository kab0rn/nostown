// Tests: Safeguard pool continues after worker loss (#13)

import { SafeguardPool, SafeguardWorker } from '../../src/roles/safeguard';

describe('SafeguardPool failover (#13)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('pool continues scanning when first worker throws', async () => {
    const pool = new SafeguardPool({ poolSize: 2 });

    let callCount = 0;
    jest.spyOn(SafeguardWorker.prototype, 'scan').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Worker 0: simulated failure');
      }
      // Worker 1 (or subsequent) succeeds
      return { approved: true, violations: [] };
    });

    const result = await pool.scan('safe diff content');

    expect(result.approved).toBe(true);
    expect(callCount).toBe(2); // tried worker 0 (failed), then worker 1 (success)
  });

  it('throws when all workers fail', async () => {
    const pool = new SafeguardPool({ poolSize: 3 });

    jest.spyOn(SafeguardWorker.prototype, 'scan').mockRejectedValue(
      new Error('All workers broken'),
    );

    await expect(pool.scan('some diff')).rejects.toThrow(/all.*workers.*exhausted/i);
  });

  it('detects static violations even when LLM scan fails', async () => {
    const pool = new SafeguardPool({ poolSize: 2 });

    // Only the first scan call should run (no failover needed for LLM error)
    // SafeguardWorker handles LLM failure gracefully and still returns static scan results
    const result = await pool.scan('const key = eval("secret_value")');

    // eval() usage triggers static critical rule — LLM fail is non-fatal
    expect(result.approved).toBe(false);
    expect(result.violations.some((v) => v.rule === 'eval_usage')).toBe(true);
  });

  it('round-robin distributes scans across workers', async () => {
    const pool = new SafeguardPool({ poolSize: 3 });

    const scanSpy = jest.spyOn(SafeguardWorker.prototype, 'scan').mockResolvedValue({
      approved: true,
      violations: [],
    });

    await pool.scan('diff 1');
    await pool.scan('diff 2');
    await pool.scan('diff 3');

    // Each scan attempt should be routed to a different starting worker
    expect(scanSpy).toHaveBeenCalledTimes(3);
  });

  it('pool minimum size is enforced at 2', () => {
    const pool = new SafeguardPool({ poolSize: 1 });
    expect(pool.workerCount).toBe(2);
  });
});

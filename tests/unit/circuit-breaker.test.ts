// Tests: Circuit breaker opens after threshold, recovers after timeout

import { CircuitBreaker } from '../../src/resilience/circuit-breaker';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker();
    expect(cb.currentState).toBe('CLOSED');
  });

  it('stays CLOSED on successful calls', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });

    for (let i = 0; i < 10; i++) {
      await cb.execute(async () => 'ok');
    }

    expect(cb.currentState).toBe('CLOSED');
    expect(cb.stats.consecutiveFailures).toBe(0);
  });

  it('opens after failureThreshold consecutive failures', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    const fail = async () => { throw new Error('provider down'); };

    await expect(cb.execute(fail)).rejects.toThrow('provider down');
    await expect(cb.execute(fail)).rejects.toThrow('provider down');
    await expect(cb.execute(fail)).rejects.toThrow('provider down');

    expect(cb.currentState).toBe('OPEN');
  });

  it('throws CIRCUIT_OPEN when open (fast-fail)', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 10_000 });
    const fail = async () => { throw new Error('fail'); };

    await expect(cb.execute(fail)).rejects.toThrow('fail');
    await expect(cb.execute(fail)).rejects.toThrow('fail');

    // Circuit is now open — next call fast-fails
    await expect(cb.execute(async () => 'never')).rejects.toThrow(/CIRCUIT_OPEN/);
  });

  it('transitions to HALF_OPEN after recovery timeout', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 5_000 });
    const fail = async () => { throw new Error('fail'); };

    await expect(cb.execute(fail)).rejects.toThrow('fail');
    await expect(cb.execute(fail)).rejects.toThrow('fail');
    expect(cb.currentState).toBe('OPEN');

    // Advance past recovery timeout
    jest.advanceTimersByTime(6_000);

    // Next call transitions to HALF_OPEN and is allowed through
    // If it fails, circuit re-opens
    await expect(cb.execute(fail)).rejects.toThrow('fail');
    expect(cb.currentState).toBe('OPEN');
  });

  it('closes circuit on success in HALF_OPEN state', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 5_000 });
    const fail = async () => { throw new Error('fail'); };

    await expect(cb.execute(fail)).rejects.toThrow();
    await expect(cb.execute(fail)).rejects.toThrow();
    expect(cb.currentState).toBe('OPEN');

    jest.advanceTimersByTime(6_000);

    // Recovery attempt succeeds → circuit closes
    const result = await cb.execute(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(cb.currentState).toBe('CLOSED');
    expect(cb.stats.consecutiveFailures).toBe(0);
  });

  it('resets failure count on success', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 5 });
    const fail = async () => { throw new Error('fail'); };

    // 4 failures (below threshold)
    for (let i = 0; i < 4; i++) {
      await expect(cb.execute(fail)).rejects.toThrow();
    }
    expect(cb.currentState).toBe('CLOSED');
    expect(cb.stats.consecutiveFailures).toBe(4);

    // 1 success resets count
    await cb.execute(async () => 'ok');
    expect(cb.stats.consecutiveFailures).toBe(0);
    expect(cb.currentState).toBe('CLOSED');
  });

  it('manual reset closes the circuit', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    const fail = async () => { throw new Error('fail'); };

    await expect(cb.execute(fail)).rejects.toThrow();
    await expect(cb.execute(fail)).rejects.toThrow();
    expect(cb.currentState).toBe('OPEN');

    cb.reset();
    expect(cb.currentState).toBe('CLOSED');

    // Can execute again
    const result = await cb.execute(async () => 'ok after reset');
    expect(result).toBe('ok after reset');
  });
});

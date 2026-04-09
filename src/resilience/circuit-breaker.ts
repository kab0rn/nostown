// NOS Town — Circuit Breaker for Groq API
// Implements the classic three-state pattern: CLOSED → OPEN → HALF_OPEN → CLOSED

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit */
  failureThreshold?: number;
  /** Time in ms before transitioning from OPEN to HALF_OPEN */
  recoveryTimeoutMs?: number;
  /** Human-readable name for logging */
  name?: string;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastFailureAt: number | null = null;
  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly name: string;

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.recoveryTimeoutMs = config.recoveryTimeoutMs ?? 60_000;
    this.name = config.name ?? 'circuit';
  }

  get currentState(): CircuitState {
    return this.state;
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws CIRCUIT_OPEN if the circuit is open and recovery timeout hasn't elapsed.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - (this.lastFailureAt ?? 0);
      if (elapsed < this.recoveryTimeoutMs) {
        throw new Error(
          `CIRCUIT_OPEN: ${this.name} is open (${Math.round((this.recoveryTimeoutMs - elapsed) / 1000)}s until recovery attempt)`,
        );
      }
      // Transition to HALF_OPEN to try one request
      this.state = 'HALF_OPEN';
      console.log(`[CircuitBreaker:${this.name}] Transitioning to HALF_OPEN (trying recovery)`);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      console.log(`[CircuitBreaker:${this.name}] Recovery successful — circuit CLOSED`);
    }
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastFailureAt = null;
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();

    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
      console.warn(
        `[CircuitBreaker:${this.name}] Circuit OPEN after ${this.consecutiveFailures} consecutive failures`,
      );
    }
  }

  /**
   * Manually reset the circuit to CLOSED state.
   */
  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastFailureAt = null;
  }

  get stats(): { state: CircuitState; consecutiveFailures: number; lastFailureAt: number | null } {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt,
    };
  }
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError';

  constructor(readonly retryInMs: number) {
    super(`Circuit is open. Retry in ${retryInMs} ms.`);
  }
}

export interface BreakerOptions {
  failureThreshold: number;
  resetMs: number;
  now?: () => number;
  /** Failures that should not count, such as a 404 from a healthy upstream. */
  isFailure?: (error: unknown) => boolean;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private current: BreakerState = 'closed';
  private readonly now: () => number;
  private readonly isFailure: (error: unknown) => boolean;

  constructor(private readonly options: BreakerOptions) {
    this.now = options.now ?? Date.now;
    this.isFailure = options.isFailure ?? (() => true);
  }

  get state(): BreakerState {
    if (this.current === 'open' && this.now() - this.openedAt >= this.options.resetMs) {
      return 'half-open';
    }
    return this.current;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'open') {
      throw new CircuitOpenError(this.options.resetMs - (this.now() - this.openedAt));
    }
    if (state === 'half-open') {
      if (this.probing) throw new CircuitOpenError(this.options.resetMs);
      this.probing = true;
      this.current = 'half-open';
    }

    try {
      const result = await operation();
      this.close();
      return result;
    } catch (error) {
      if (this.isFailure(error)) this.recordFailure();
      else this.close();
      throw error;
    } finally {
      this.probing = false;
    }
  }

  private close(): void {
    this.failures = 0;
    this.current = 'closed';
  }

  private recordFailure(): void {
    this.failures += 1;
    if (this.current === 'half-open' || this.failures >= this.options.failureThreshold) {
      this.current = 'open';
      this.openedAt = this.now();
    }
  }
}

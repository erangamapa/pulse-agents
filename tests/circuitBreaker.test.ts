import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../src/clients/circuitBreaker.js';
import { createBreakerForEngine } from '../src/clients/bettingEngine.js';
import { HttpError } from '../src/clients/http.js';
import { FakeClock } from './fakes.js';

const failing = async (): Promise<never> => {
  throw new Error('upstream down');
};

describe('CircuitBreaker', () => {
  it('opens after the threshold and rejects without calling upstream', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetMs: 10_000, now: clock.now });
    for (let index = 0; index < 3; index += 1) await expect(breaker.execute(failing)).rejects.toThrow('upstream down');

    expect(breaker.state).toBe('open');
    let called = false;
    await expect(
      breaker.execute(async () => {
        called = true;
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it('half opens after the reset window and closes on a good probe', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetMs: 10_000, now: clock.now });
    await expect(breaker.execute(failing)).rejects.toThrow();
    await expect(breaker.execute(failing)).rejects.toThrow();

    clock.advance(10_000);
    expect(breaker.state).toBe('half-open');
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
  });

  it('reopens when the half open probe fails', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetMs: 10_000, now: clock.now });
    await expect(breaker.execute(failing)).rejects.toThrow();
    await expect(breaker.execute(failing)).rejects.toThrow();

    clock.advance(10_000);
    await expect(breaker.execute(failing)).rejects.toThrow('upstream down');
    expect(breaker.state).toBe('open');
    await expect(breaker.execute(async () => 'ok')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('allows only one probe while half open', async () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetMs: 5_000, now: clock.now });
    await expect(breaker.execute(failing)).rejects.toThrow();
    clock.advance(5_000);

    let release: () => void = () => undefined;
    const probe = breaker.execute(() => new Promise<void>((resolve) => (release = resolve)));
    await expect(breaker.execute(async () => 'second')).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    await probe;
  });

  it('does not count a client error from a healthy engine', async () => {
    const clock = new FakeClock();
    const breaker = createBreakerForEngine({ failureThreshold: 1, resetMs: 5_000, now: clock.now });
    await expect(
      breaker.execute(async () => {
        throw new HttpError(422, 'http://engine.internal/x');
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(breaker.state).toBe('closed');

    await expect(
      breaker.execute(async () => {
        throw new HttpError(503, 'http://engine.internal/x');
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(breaker.state).toBe('open');
  });
});

import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../src/placement/queue.js';
import { FakeClock } from './fakes.js';

describe('TokenBucket', () => {
  it('lets 50 through in a second and holds the 51st', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(50, clock);

    const granted = Array.from({ length: 60 }, () => bucket.tryTake()).filter(Boolean).length;
    expect(granted).toBe(50);
  });

  it('refills at 50 per second and never beyond that', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(50, clock);
    for (let index = 0; index < 50; index += 1) bucket.tryTake();

    clock.advance(500);
    expect(Array.from({ length: 60 }, () => bucket.tryTake()).filter(Boolean).length).toBe(25);

    clock.advance(10_000);
    expect(Array.from({ length: 80 }, () => bucket.tryTake()).filter(Boolean).length).toBe(50);
  });

  it('acquire waits for a token instead of failing', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(50, clock);
    for (let index = 0; index < 50; index += 1) bucket.tryTake();

    const before = clock.now();
    await bucket.acquire();
    expect(clock.now() - before).toBeGreaterThanOrEqual(20);
  });

  it('spreads 200 acquires over about four seconds', async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(50, clock);
    const started = clock.now();
    for (let index = 0; index < 200; index += 1) await bucket.acquire();

    const elapsed = clock.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2_900);
    expect(elapsed).toBeLessThan(4_100);
  });
});

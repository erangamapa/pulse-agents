import { betProposal } from 'sportsbook-contracts';
import { z } from 'zod';

export const placementOrder = z.object({
  orderId: z.string().min(1),
  accountId: z.string().min(1),
  conversationId: z.string().min(1),
  proposal: betProposal,
  /** Set only by a human confirmation. The worker refuses an order without it. */
  confirmationRef: z.string().min(1).optional(),
});
export type PlacementOrder = z.infer<typeof placementOrder>;

export type OrderHandler = (order: PlacementOrder) => Promise<void>;

export interface PlacementConsumer {
  stop(): Promise<void>;
}

export interface PlacementQueue {
  enqueue(order: PlacementOrder): Promise<void>;
  consume(handler: OrderHandler): PlacementConsumer;
}

export interface BucketClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: BucketClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Refills continuously, so a burst is capped at one second of capacity. */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly clock: BucketClock = systemClock,
  ) {
    this.tokens = ratePerSecond;
    this.lastRefill = clock.now();
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  async acquire(): Promise<void> {
    while (!this.tryTake()) {
      const missing = 1 - this.tokens;
      await this.clock.sleep(Math.max(1, Math.ceil((missing / this.ratePerSecond) * 1_000)));
    }
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsedSeconds = (now - this.lastRefill) / 1_000;
    this.tokens = Math.min(this.ratePerSecond, this.tokens + elapsedSeconds * this.ratePerSecond);
    this.lastRefill = now;
  }
}

/** Runs the handler inline after enqueue. Good enough for tests and local runs. */
export class InMemoryQueue implements PlacementQueue {
  readonly failures: { order: PlacementOrder; error: unknown }[] = [];
  private handler: OrderHandler | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  async enqueue(order: PlacementOrder): Promise<void> {
    const parsed = placementOrder.parse(order);
    const run = this.inFlight.then(async () => {
      if (!this.handler) return;
      try {
        await this.handler(parsed);
      } catch (error) {
        this.failures.push({ order: parsed, error });
      }
    });
    this.inFlight = run;
    await run;
  }

  consume(handler: OrderHandler): PlacementConsumer {
    this.handler = handler;
    return {
      stop: async () => {
        this.handler = undefined;
        await this.inFlight;
      },
    };
  }
}

export interface TaskDispatcher {
  /** Creates a task whose name makes creation idempotent, so a retried enqueue cannot double up. */
  createTask(input: { name: string; body: PlacementOrder }): Promise<void>;
}

/**
 * Cloud Tasks pushes each task back to this service over http. The route calls
 * deliver(), and a thrown error becomes a non 2xx so Cloud Tasks retries it.
 * Retries and bursts arrive through deliver(), not enqueue(), and deliver() is
 * what reaches the betting engine. So both sides take a token, each from its
 * own bucket, and delivery never exceeds the rate the engine accepts.
 */
export class CloudTasksQueue implements PlacementQueue {
  private handler: OrderHandler | undefined;
  private active = 0;
  private idle: (() => void) | undefined;

  constructor(
    private readonly dispatcher: TaskDispatcher,
    private readonly enqueueBucket: TokenBucket,
    private readonly deliverBucket: TokenBucket,
  ) {}

  async enqueue(order: PlacementOrder): Promise<void> {
    const parsed = placementOrder.parse(order);
    await this.enqueueBucket.acquire();
    await this.dispatcher.createTask({ name: `placement-${parsed.orderId}`, body: parsed });
  }

  consume(handler: OrderHandler): PlacementConsumer {
    this.handler = handler;
    return {
      stop: async () => {
        this.handler = undefined;
        if (this.active > 0) await new Promise<void>((resolve) => (this.idle = resolve));
      },
    };
  }

  async deliver(raw: unknown): Promise<void> {
    const handler = this.handler;
    if (!handler) throw new Error('Placement consumer is not running.');
    const order = placementOrder.parse(raw);
    await this.deliverBucket.acquire();
    this.active += 1;
    try {
      await handler(order);
    } finally {
      this.active -= 1;
      if (this.active === 0) this.idle?.();
    }
  }
}

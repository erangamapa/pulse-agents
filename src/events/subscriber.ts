import type { Message, PubSub } from '@google-cloud/pubsub';
import type { Logger } from '../observability/logger.js';

export const TOPICS = {
  mentions: 'mention.created',
  directMessages: 'dm.message.created',
  news: 'sports-news',
  settlements: 'bet-settlements',
  placementResults: 'placement-results',
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

export interface DeliveryMeta {
  messageId: string;
  attempt: number;
}

export type EventHandler = (payload: unknown, meta: DeliveryMeta) => Promise<void>;

export interface Subscription {
  stop(): Promise<void>;
}

export interface EventBus {
  publish(topic: Topic, payload: unknown): Promise<void>;
  subscribe(topic: Topic, handler: EventHandler): Subscription;
}

export interface DeadLetter {
  topic: Topic;
  payload: unknown;
  error: string;
}

/**
 * Delivers inline and retries a failing handler, then parks the message in
 * deadLetters. That mirrors what the broker does with a dead letter policy.
 */
export class InMemoryBus implements EventBus {
  readonly deadLetters: DeadLetter[] = [];
  private readonly handlers = new Map<Topic, Set<EventHandler>>();
  private sequence = 0;

  constructor(private readonly maxAttempts = 3) {}

  async publish(topic: Topic, payload: unknown): Promise<void> {
    const messageId = `mem-${(this.sequence += 1)}`;
    for (const handler of [...(this.handlers.get(topic) ?? [])]) {
      await this.deliver(topic, handler, payload, messageId);
    }
  }

  subscribe(topic: Topic, handler: EventHandler): Subscription {
    const set = this.handlers.get(topic) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(topic, set);
    return {
      stop: async () => {
        set.delete(handler);
      },
    };
  }

  private async deliver(
    topic: Topic,
    handler: EventHandler,
    payload: unknown,
    messageId: string,
  ): Promise<void> {
    let lastError = 'unknown failure';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await handler(payload, { messageId, attempt });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.deadLetters.push({ topic, payload, error: lastError });
  }
}

export interface PubSubBusOptions {
  /** Naming convention for the pull subscription that infra creates per topic. */
  subscriptionFor?: (topic: Topic) => string;
  ackDeadlineSeconds?: number;
  maxInFlight?: number;
}

/**
 * The broker owns redelivery. A handler that throws nacks the message, and the
 * subscription's dead letter policy (set in infra, max 5 delivery attempts)
 * moves it to the DLQ topic. The service never drops a message on its own.
 */
export class PubSubBus implements EventBus {
  private readonly subscriptionFor: (topic: Topic) => string;
  private readonly ackDeadlineSeconds: number;
  private readonly maxInFlight: number;

  constructor(
    private readonly client: PubSub,
    private readonly logger: Logger,
    options: PubSubBusOptions = {},
  ) {
    this.subscriptionFor = options.subscriptionFor ?? ((topic) => `${topic}.pulse-agents`);
    this.ackDeadlineSeconds = options.ackDeadlineSeconds ?? 60;
    this.maxInFlight = options.maxInFlight ?? 20;
  }

  async publish(topic: Topic, payload: unknown): Promise<void> {
    await this.client.topic(topic).publishMessage({ json: payload });
  }

  subscribe(topic: Topic, handler: EventHandler): Subscription {
    const subscription = this.client.subscription(this.subscriptionFor(topic), {
      ackDeadline: this.ackDeadlineSeconds,
      flowControl: { maxMessages: this.maxInFlight, allowExcessMessages: false },
    });

    subscription.on('message', (message: Message) => {
      void this.handle(topic, handler, message);
    });
    subscription.on('error', (error: Error) => {
      this.logger.error({ topic, err: error }, 'subscription error');
    });

    return { stop: () => subscription.close() };
  }

  private async handle(topic: Topic, handler: EventHandler, message: Message): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(message.data.toString('utf8'));
    } catch {
      this.logger.warn({ topic, messageId: message.id }, 'dropping message that is not json');
      message.ack();
      return;
    }
    try {
      await handler(payload, { messageId: message.id, attempt: message.deliveryAttempt ?? 1 });
      message.ack();
    } catch (error) {
      this.logger.error({ topic, messageId: message.id, err: error }, 'handler failed, nacking');
      message.nack();
    }
  }
}

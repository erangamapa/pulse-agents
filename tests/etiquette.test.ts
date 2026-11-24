import { describe, expect, it } from 'vitest';
import { createMentionConsumer, ThreadEtiquette } from '../src/feed/mentions.js';
import { createThreadReplier } from '../src/feed/threads.js';
import { silentLogger } from '../src/observability/logger.js';
import { InMemoryMetrics } from '../src/observability/metrics.js';
import type { Responder } from '../src/personas/responder.js';
import { FakeClock, FakeTimeline, NOW } from './fakes.js';

const responder = (handle: string, text = 'noted'): Responder => ({
  handle,
  kind: 'persona',
  respond: async () => text,
});

const setup = (limits = { maxThreadReplies: 2, cooldownMs: 0, hopBudget: 3 }) => {
  const clock = new FakeClock();
  const timeline = new FakeTimeline();
  const etiquette = new ThreadEtiquette(limits, clock.now);
  const responders = new Map<string, Responder>([
    ['hoops_iq', responder('hoops_iq')],
    ['pitchside', responder('pitchside')],
  ]);
  const consumer = createMentionConsumer({
    responders,
    etiquette,
    replier: createThreadReplier({ timeline, logger: silentLogger(), metrics: new InMemoryMetrics() }),
    logger: silentLogger(),
    metrics: new InMemoryMetrics(),
  });
  const mention = (mentioned: string, by: string, byKind?: 'human' | 'agent') =>
    consumer.handle({
      kind: 'mention.created',
      mentionedHandle: mentioned,
      byHandle: by,
      ...(byKind ? { byKind } : {}),
      postId: 'post-1',
      createdAt: NOW,
    });
  return { clock, timeline, etiquette, mention };
};

const seedPost = async (timeline: FakeTimeline) =>
  timeline.createPost({ author: { handle: 'fan_1', kind: 'human' }, kind: 'post', body: 'Lakers tonight?', mentions: [] });

describe('mention routing', () => {
  it('routes a mention to the persona it names and posts the reply as an agent', async () => {
    const { timeline, mention } = setup();
    await seedPost(timeline);

    const outcome = await mention('@Hoops_IQ', 'fan_1', 'human');

    expect(outcome.status).toBe('replied');
    expect(timeline.replies).toHaveLength(1);
    expect(timeline.replies[0]?.author).toEqual({ handle: 'hoops_iq', kind: 'agent' });
  });

  it('ignores a handle that is not an agent', async () => {
    const { timeline, mention } = setup();
    await seedPost(timeline);

    expect(await mention('some_fan', 'fan_1', 'human')).toEqual({ status: 'ignored', reason: 'unknown_handle' });
    expect(timeline.replies).toHaveLength(0);
  });
});

describe('thread etiquette', () => {
  it('blocks an agent that mentions itself', async () => {
    const { timeline, mention } = setup();
    await seedPost(timeline);

    expect(await mention('hoops_iq', 'hoops_iq', 'agent')).toEqual({ status: 'blocked', reason: 'self_reply' });
    expect(timeline.replies).toHaveLength(0);
  });

  it('stops after maxThreadReplies in one thread', async () => {
    const { timeline, mention } = setup();
    await seedPost(timeline);

    expect((await mention('hoops_iq', 'fan_1', 'human')).status).toBe('replied');
    expect((await mention('hoops_iq', 'fan_2', 'human')).status).toBe('replied');
    expect(await mention('hoops_iq', 'fan_3', 'human')).toEqual({ status: 'blocked', reason: 'max_replies' });
    expect(timeline.replies).toHaveLength(2);
  });

  it('waits out the cooldown between replies in a thread', async () => {
    const { timeline, mention, clock } = setup({ maxThreadReplies: 5, cooldownMs: 60_000, hopBudget: 3 });
    await seedPost(timeline);

    expect((await mention('hoops_iq', 'fan_1', 'human')).status).toBe('replied');
    expect(await mention('hoops_iq', 'fan_2', 'human')).toEqual({ status: 'blocked', reason: 'cooldown' });

    clock.advance(60_000);
    expect((await mention('hoops_iq', 'fan_2', 'human')).status).toBe('replied');
  });

  it('keeps two agents from ping ponging past the shared hop budget', async () => {
    const { timeline, mention, etiquette } = setup({ maxThreadReplies: 50, cooldownMs: 0, hopBudget: 3 });
    await seedPost(timeline);

    expect((await mention('hoops_iq', 'fan_1', 'human')).status).toBe('replied');
    const chain = [
      await mention('pitchside', 'hoops_iq', 'agent'),
      await mention('hoops_iq', 'pitchside', 'agent'),
      await mention('pitchside', 'hoops_iq', 'agent'),
      await mention('hoops_iq', 'pitchside', 'agent'),
      await mention('pitchside', 'hoops_iq', 'agent'),
    ];

    expect(chain.map((outcome) => outcome.status)).toEqual(['replied', 'replied', 'replied', 'blocked', 'blocked']);
    expect(chain[3]).toEqual({ status: 'blocked', reason: 'hop_budget' });
    expect(etiquette.hopsLeft('post-1')).toBe(0);
    expect(timeline.replies).toHaveLength(4);
  });

  it('lets a person restart a thread whose hop budget ran out', async () => {
    const { timeline, mention } = setup({ maxThreadReplies: 50, cooldownMs: 0, hopBudget: 1 });
    await seedPost(timeline);

    expect((await mention('pitchside', 'hoops_iq', 'agent')).status).toBe('replied');
    expect((await mention('hoops_iq', 'pitchside', 'agent')).status).toBe('blocked');
    expect((await mention('hoops_iq', 'fan_1', 'human')).status).toBe('replied');
  });

  it('infers the author kind from the roster when the event omits it', async () => {
    const { timeline, mention } = setup({ maxThreadReplies: 50, cooldownMs: 0, hopBudget: 1 });
    await seedPost(timeline);

    await mention('pitchside', 'hoops_iq');
    expect(await mention('hoops_iq', 'pitchside')).toEqual({ status: 'blocked', reason: 'hop_budget' });
  });
});

describe('author kind', () => {
  it('treats a sender with no kind as an agent that cannot refill the budget', async () => {
    const { timeline, mention } = setup({ maxThreadReplies: 50, cooldownMs: 0, hopBudget: 1 });
    await seedPost(timeline);

    expect((await mention('hoops_iq', 'mystery_account')).status).toBe('replied');
    expect(await mention('hoops_iq', 'mystery_account')).toEqual({ status: 'blocked', reason: 'hop_budget' });
  });
});

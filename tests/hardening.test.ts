import type { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { createAnalystAgent } from '../src/analyst/analystAgent.js';
import { OddsStreamClient } from '../src/clients/oddsStream.js';
import { createConfirmationWatcher } from '../src/dm/confirmations.js';
import { createDmDesk, MissingTickError } from '../src/dm/dmAgent.js';
import { createInternalRoutes, tokenMatches } from '../src/internalRoutes.js';
import { silentLogger } from '../src/observability/logger.js';
import { InMemoryMetrics } from '../src/observability/metrics.js';
import { PERSONAS } from '../src/personas/definitions.js';
import { createPersonaAgent } from '../src/personas/personaAgent.js';
import { CloudTasksQueue, InMemoryQueue, TokenBucket, type PlacementOrder } from '../src/placement/queue.js';
import { createTimelineVerifier } from '../src/placement/verifier.js';
import { createOddsSource } from '../src/tools/shared.js';
import { BoundedSet } from '../src/util/boundedSet.js';
import { FakeClock, FakeEngine, FakeOdds, FakeStats, FakeTimeline, NOW, tick } from './fakes.js';
import { ScriptedModel, finalAnswer, routerFor, toolCall } from './scriptedModel.js';

const ref = { eventId: 'evt-1', marketId: 'mkt-1', selectionId: 'sel-1' };
const nowMs = Date.parse(NOW);

const streamWith = (connected: boolean, ticks: ReturnType<typeof tick>[]) => {
  const stream = new OddsStreamClient({
    url: 'http://odds.internal/stream',
    fetch: async () => {
      throw new Error('no network in tests');
    },
    logger: silentLogger(),
    metrics: new InMemoryMetrics(),
  });
  ticks.forEach((value) => stream.ingest(value));
  return Object.assign(stream, { isConnected: () => connected });
};

describe('odds freshness', () => {
  it('uses the streamed tick while it is fresh and the stream is connected', async () => {
    const engine = new FakeEngine();
    const source = createOddsSource(streamWith(true, [tick('sel-1', { price: '1.7000', ts: NOW })]), engine, {
      maxAgeMs: 10_000,
      now: () => nowMs + 5_000,
    });

    expect((await source.current(ref)).price).toBe('1.7000');
  });

  it('goes to the engine when the held tick is older than the bound', async () => {
    const source = createOddsSource(streamWith(true, [tick('sel-1', { price: '1.7000', ts: NOW })]), new FakeEngine(), {
      maxAgeMs: 10_000,
      now: () => nowMs + 10_001,
    });

    expect((await source.current(ref)).price).toBe('1.9000');
  });

  it('goes to the engine when the stream is disconnected, however fresh the tick looks', async () => {
    const source = createOddsSource(streamWith(false, [tick('sel-1', { price: '1.7000', ts: NOW })]), new FakeEngine(), {
      now: () => nowMs,
    });

    expect((await source.current(ref)).price).toBe('1.9000');
  });
});

describe('internal routes', () => {
  const setup = () => {
    const delivered: unknown[] = [];
    let attempts = 0;
    let failFirst = false;
    const routes = createInternalRoutes({
      authToken: 'shared-secret-value',
      deliverPlacement: async (order) => {
        attempts += 1;
        if (failFirst && attempts === 1) throw new Error('engine down');
        delivered.push(order);
      },
      runCron: async () => ['hoops_iq'],
    });
    const call = (url: string, headers: Record<string, string> = {}) =>
      routes.handle({ method: 'POST', url, headers, body: { orderId: 'o-1' } });
    return { delivered, call, failFirst: () => (failFirst = true) };
  };
  const auth = { authorization: 'Bearer shared-secret-value' };

  it('rejects placements and cron without the shared secret', async () => {
    const { call, delivered } = setup();

    expect((await call('/internal/placements'))?.status).toBe(401);
    expect((await call('/internal/placements', { authorization: 'Bearer wrong' }))?.status).toBe(401);
    expect((await call('/internal/cron/tick'))?.status).toBe(401);
    expect(delivered).toHaveLength(0);
  });

  it('accepts the secret and leaves other routes alone', async () => {
    const { call } = setup();

    expect((await call('/internal/cron/tick', auth))?.status).toBe(200);
    expect((await call('/internal/placements', auth))?.status).toBe(202);
    expect(await call('/somewhere/else', auth)).toBeUndefined();
  });

  it('runs a named task once even when it is pushed twice', async () => {
    const { call, delivered } = setup();
    const headers = { ...auth, 'x-task-name': 'placement-order-1' };

    expect((await call('/internal/placements', headers))?.status).toBe(202);
    expect((await call('/internal/placements', headers))?.body).toEqual({ accepted: true, duplicate: true });
    expect(delivered).toHaveLength(1);
  });

  it('lets a task retry after a failed attempt', async () => {
    const { call, delivered, failFirst } = setup();
    failFirst();
    const headers = { ...auth, 'x-task-name': 'placement-order-2' };

    await expect(call('/internal/placements', headers)).rejects.toThrow('engine down');
    expect((await call('/internal/placements', headers))?.status).toBe(202);
    expect(delivered).toHaveLength(1);
  });

  it('compares tokens without accepting a missing or prefix value', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('ab', 'abc')).toBe(false);
    expect(tokenMatches(undefined, '')).toBe(false);
  });
});

describe('delivery rate', () => {
  it('holds delivery to 50 per second, not only enqueue', async () => {
    const clock = new FakeClock();
    const handled: string[] = [];
    const queue = new CloudTasksQueue(
      { createTask: async () => undefined },
      new TokenBucket(50, clock),
      new TokenBucket(50, clock),
    );
    queue.consume(async (order) => void handled.push(order.orderId));
    const order = (id: string): PlacementOrder => ({
      orderId: id,
      accountId: 'acct-1',
      conversationId: 'conv-1',
      confirmationRef: 'dm:conv-1:m-1',
      proposal: {
        state: 'confirmed',
        selections: [{ eventId: 'e', marketId: 'm', selectionId: 's', price: '2.0000' }],
        stake: { currency: 'USDT', amount: '1' },
      },
    });

    const started = clock.now();
    for (let index = 0; index < 150; index += 1) await queue.deliver(order(`o-${index}`));

    expect(handled).toHaveLength(150);
    expect(clock.now() - started).toBeGreaterThanOrEqual(1_900);
  });
});

describe('confirmation checks', () => {
  const conversation = {
    conversationId: 'conv-1',
    participants: [
      { handle: 'hoops_iq', kind: 'agent' as const },
      { handle: 'sam', kind: 'human' as const },
    ],
  };
  const selections = [{ ...ref, price: '2.1000' }];
  const stake = { currency: 'USDT', amount: '20' };

  const stage = async (timeline: FakeTimeline, expiresAt?: string) =>
    timeline.createDm('conv-1', {
      from: { handle: 'hoops_iq', kind: 'agent' },
      body: 'Lakers 2.10?',
      betProposal: { state: 'proposed', selections, stake, ...(expiresAt ? { expiresAt } : {}) },
    });

  const confirm = (timeline: FakeTimeline, overrides: Record<string, unknown> = {}, expiresAt?: string) =>
    timeline.createDm('conv-1', {
      from: { handle: 'sam', kind: 'human' },
      body: 'Confirm',
      betProposal: { state: 'confirmed', selections, stake, ...(expiresAt ? { expiresAt } : {}), ...overrides },
    });

  const watch = (timeline: FakeTimeline, queue = new InMemoryQueue()) =>
    createConfirmationWatcher({
      timeline,
      queue,
      logger: silentLogger(),
      metrics: new InMemoryMetrics(),
      now: () => nowMs,
    });
  const event = (messageId: string) => ({
    kind: 'dm.message.created',
    messageId,
    conversationId: 'conv-1',
    fromHandle: 'sam',
    fromKind: 'human',
    hasBetProposal: true,
    createdAt: NOW,
  });
  const future = '2025-03-01T12:05:00.000Z';

  it('queues only when the confirmed payload equals the staged proposal', async () => {
    const timeline = new FakeTimeline();
    timeline.conversations.set('conv-1', conversation);
    await stage(timeline, future);
    const confirmation = await confirm(timeline, {}, future);

    expect((await watch(timeline).handle(event(confirmation.messageId))).status).toBe('queued');
  });

  it('ignores a confirmation whose stake was raised after staging', async () => {
    const timeline = new FakeTimeline();
    await stage(timeline, future);
    const forged = await confirm(timeline, { stake: { currency: 'USDT', amount: '2000' } }, future);

    expect(await watch(timeline).handle(event(forged.messageId))).toEqual({
      status: 'ignored',
      reason: 'no staged proposal matches',
    });
  });

  it('ignores a confirmation for a proposal nobody staged', async () => {
    const timeline = new FakeTimeline();
    const orphan = await confirm(timeline, {}, future);

    expect((await watch(timeline).handle(event(orphan.messageId))).status).toBe('ignored');
  });

  it('treats a staged proposal with no expiry as expired', async () => {
    const timeline = new FakeTimeline();
    await stage(timeline);
    const confirmation = await confirm(timeline);

    expect(await watch(timeline).handle(event(confirmation.messageId))).toEqual({
      status: 'ignored',
      reason: 'proposal expired',
    });
  });

  it('ignores a proposal that expired before the confirmation', async () => {
    const timeline = new FakeTimeline();
    const past = '2025-03-01T11:00:00.000Z';
    await stage(timeline, past);
    const confirmation = await confirm(timeline, {}, past);

    expect((await watch(timeline).handle(event(confirmation.messageId))).status).toBe('ignored');
  });

  it('lets the worker side verifier reject a ref the timeline does not back', async () => {
    const timeline = new FakeTimeline();
    await stage(timeline, future);
    const confirmation = await confirm(timeline, {}, future);
    const verifier = createTimelineVerifier(timeline);
    const order: PlacementOrder = {
      orderId: 'o-1',
      accountId: 'acct-sam',
      conversationId: 'conv-1',
      confirmationRef: `dm:conv-1:${confirmation.messageId}`,
      proposal: { state: 'confirmed', selections, stake, expiresAt: future },
    };

    expect(await verifier.verify(order)).toEqual({ ok: true });
    expect((await verifier.verify({ ...order, confirmationRef: 'dm:conv-1:nope' })).ok).toBe(false);
    expect((await verifier.verify({ ...order, confirmationRef: 'bogus' })).ok).toBe(false);
    expect((await verifier.verify({ ...order, accountId: 'acct-other' })).ok).toBe(false);
    expect(
      (await verifier.verify({ ...order, proposal: { ...order.proposal, stake: { currency: 'USDT', amount: '21' } } })).ok,
    ).toBe(false);
  });
});

describe('dm staging', () => {
  it('stages nothing when a price is missing', async () => {
    const timeline = new FakeTimeline();
    timeline.conversations.set('conv-1', {
      conversationId: 'conv-1',
      participants: [
        { handle: 'hoops_iq', kind: 'agent' },
        { handle: 'sam', kind: 'human' },
      ],
    });
    const model = new ScriptedModel([
      toolCall('c1', 'proposeBet', { selections: [ref], stake: { currency: 'USDT', amount: '5' }, message: 'Try it' }),
      finalAnswer('No price right now.'),
    ]);
    const desk = createDmDesk({
      router: routerFor(model),
      odds: { current: async () => undefined as never },
      stats: new FakeStats(),
      timeline,
      metrics: new InMemoryMetrics(),
      logger: silentLogger(),
    });
    const incoming = await timeline.createDm('conv-1', { from: { handle: 'sam', kind: 'human' }, body: 'bet it' });

    await desk.handleMessage({
      kind: 'dm.message.created',
      messageId: incoming.messageId,
      conversationId: 'conv-1',
      fromHandle: 'sam',
      fromKind: 'human',
      hasBetProposal: false,
      createdAt: NOW,
    });

    expect(timeline.dms.some((message) => message.betProposal)).toBe(false);
    expect(new MissingTickError('sel-1').message).toContain('sel-1');
  });
});

describe('bounded memory', () => {
  it('evicts the oldest key when full', () => {
    const set = new BoundedSet<string>({ maxSize: 2 });
    ['a', 'b', 'c'].forEach((key) => set.add(key));

    expect([set.has('a'), set.has('b'), set.has('c')]).toEqual([false, true, true]);
    expect(set.size).toBe(2);
  });

  it('forgets a key after its ttl', () => {
    const clock = new FakeClock();
    const set = new BoundedSet<string>({ maxSize: 10, ttlMs: 1_000, now: clock.now });
    set.add('a');
    clock.advance(999);
    expect(set.has('a')).toBe(true);
    clock.advance(1);
    expect(set.has('a')).toBe(false);
  });
});

describe('persona post guard', () => {
  it('lets a later run on the same thread post after a reply run did', async () => {
    const timeline = new FakeTimeline();
    const post = (id: string): AIMessage =>
      toolCall(id, 'submitPostIntent', { kind: 'post', body: 'Pace favours the over.' });
    const model = new ScriptedModel([post('p1'), finalAnswer('Posted.'), post('p2'), finalAnswer('Posted again.')]);
    const router = routerFor(model);
    const odds = new FakeOdds();
    const metrics = new InMemoryMetrics();
    const analyst = createAnalystAgent({
      router,
      odds,
      scoring: { winProbability: async () => ({ probability: 0.5, modelVersion: 'x' }) },
      metrics,
    });
    const persona = PERSONAS[0];
    if (!persona) throw new Error('no personas');
    const agent = createPersonaAgent(persona, { router, odds, stats: new FakeStats(), timeline, analyst, metrics });
    const threadId = 'thread:post-1:hoops_iq';

    await agent.respond('first mention', { threadId });
    await agent.respond('second mention', { threadId });

    expect(timeline.posts).toHaveLength(2);
  });
});

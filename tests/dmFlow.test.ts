import type { AIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { createConfirmationWatcher } from '../src/dm/confirmations.js';
import { createDmDesk } from '../src/dm/dmAgent.js';
import { InMemoryBus } from '../src/events/subscriber.js';
import { silentLogger } from '../src/observability/logger.js';
import { InMemoryMetrics } from '../src/observability/metrics.js';
import { InMemoryLedger } from '../src/placement/ledger.js';
import { InMemoryQueue } from '../src/placement/queue.js';
import { createPlacementWorker } from '../src/placement/worker.js';
import { createTimelineVerifier } from '../src/placement/verifier.js';
import { FakeEngine, FakeOdds, FakeStats, FakeTimeline, NOW, tick } from './fakes.js';
import { ScriptedModel, finalAnswer, routerFor, toolCall } from './scriptedModel.js';

const ref = { eventId: 'evt-1', marketId: 'mkt-1', selectionId: 'sel-1' };

const setup = (script: readonly AIMessage[]) => {
  const timeline = new FakeTimeline();
  timeline.conversations.set('conv-1', {
    conversationId: 'conv-1',
    participants: [
      { handle: 'hoops_iq', kind: 'agent' },
      { handle: 'sam', kind: 'human' },
    ],
  });
  const odds = new FakeOdds();
  odds.set(tick('sel-1', { price: '2.1000' }));
  const model = new ScriptedModel(script);
  const desk = createDmDesk({
    router: routerFor(model),
    odds,
    stats: new FakeStats(),
    timeline,
    metrics: new InMemoryMetrics(),
    logger: silentLogger(),
    now: () => Date.parse(NOW),
  });
  return { timeline, odds, model, desk };
};

const humanMessage = async (timeline: FakeTimeline, body: string, betProposal?: unknown) =>
  timeline.createDm('conv-1', {
    from: { handle: 'sam', kind: 'human' },
    body,
    ...(betProposal ? { betProposal: betProposal as never } : {}),
  });

const eventFor = (messageId: string, hasBetProposal: boolean) => ({
  kind: 'dm.message.created',
  messageId,
  conversationId: 'conv-1',
  fromHandle: 'sam',
  fromKind: 'human',
  hasBetProposal,
  createdAt: NOW,
});

describe('dm proposal to placement', () => {
  it('stages a proposal with a live price and never places by itself', async () => {
    const { timeline, desk, odds } = setup([
      toolCall('c1', 'getOdds', ref),
      toolCall('c2', 'proposeBet', { selections: [ref], stake: { currency: 'USDT', amount: '20' }, message: 'Lakers at 2.10, 20 USDT?' }),
      finalAnswer('Proposal is in the chat.'),
    ]);
    const incoming = await humanMessage(timeline, 'Back the Lakers for 20 bucks');

    const outcome = await desk.handleMessage(eventFor(incoming.messageId, false));

    expect(outcome).toBe('answered');
    const proposal = timeline.dms.find((message) => message.betProposal);
    expect(proposal?.from).toEqual({ handle: 'hoops_iq', kind: 'agent' });
    expect(proposal?.betProposal).toMatchObject({
      state: 'proposed',
      stake: { amount: '20' },
      expiresAt: '2025-03-01T12:05:00.000Z',
      selections: [{ selectionId: 'sel-1', price: '2.1000' }],
    });
    expect(odds.requests.length).toBeGreaterThanOrEqual(2);
    expect(timeline.dms.filter((message) => message.from.kind === 'agent')).toHaveLength(1);
  });

  it('refuses to propose a suspended selection', async () => {
    const { timeline, desk, odds } = setup([
      toolCall('c1', 'proposeBet', { selections: [ref], stake: { currency: 'USDT', amount: '20' }, message: 'Try this' }),
      finalAnswer('That market is suspended right now.'),
    ]);
    odds.set(tick('sel-1', { status: 'suspended' }));
    const incoming = await humanMessage(timeline, 'bet it');

    await desk.handleMessage(eventFor(incoming.messageId, false));

    expect(timeline.dms.some((message) => message.betProposal)).toBe(false);
    expect(timeline.dms.at(-1)?.body).toContain('suspended');
  });

  it('turns a human confirmation into one placement order and one bet', async () => {
    const { timeline, desk } = setup([
      toolCall('c1', 'proposeBet', { selections: [ref], stake: { currency: 'USDT', amount: '20' }, message: 'Lakers 2.10, 20 USDT?' }),
      finalAnswer('done'),
    ]);
    const incoming = await humanMessage(timeline, 'Back the Lakers for 20');
    await desk.handleMessage(eventFor(incoming.messageId, false));
    const proposed = timeline.dms.find((message) => message.betProposal);
    if (!proposed?.betProposal) throw new Error('proposal missing');

    const engine = new FakeEngine();
    const ledger = new InMemoryLedger();
    const queue = new InMemoryQueue();
    const worker = createPlacementWorker({
      engine,
      ledger,
      verifier: createTimelineVerifier(timeline),
      bus: new InMemoryBus(),
      logger: silentLogger(),
      metrics: new InMemoryMetrics(),
      commissionBasisPoints: 200,
      now: () => Date.parse(NOW),
    });
    queue.consume(worker.handler);
    const watcher = createConfirmationWatcher({
      timeline,
      queue,
      logger: silentLogger(),
      metrics: new InMemoryMetrics(),
      now: () => Date.parse(NOW),
    });

    expect(await watcher.handle(eventFor(proposed.messageId, true))).toMatchObject({ status: 'ignored' });
    expect(engine.bets.size).toBe(0);

    const confirmation = await humanMessage(timeline, 'Confirm', { ...proposed.betProposal, state: 'confirmed' });
    const first = await watcher.handle(eventFor(confirmation.messageId, true));
    const second = await watcher.handle(eventFor(confirmation.messageId, true));

    expect(first.status).toBe('queued');
    expect(second).toEqual({ status: 'ignored', reason: 'already queued' });
    expect(first.status === 'queued' && first.order).toMatchObject({
      accountId: 'acct-sam',
      confirmationRef: `dm:conv-1:${confirmation.messageId}`,
    });
    expect(engine.bets.size).toBe(1);
    expect(ledger.rows).toHaveLength(1);
  });

  it('ignores a confirmation that an agent wrote', async () => {
    const { timeline } = setup([finalAnswer('x')]);
    const forged = await timeline.createDm('conv-1', {
      from: { handle: 'hoops_iq', kind: 'agent' },
      body: 'Confirmed',
      betProposal: {
        state: 'confirmed',
        selections: [{ ...ref, price: '2.1000' }],
        stake: { currency: 'USDT', amount: '500' },
      },
    });
    const queue = new InMemoryQueue();
    const watcher = createConfirmationWatcher({
      timeline,
      queue,
      logger: silentLogger(),
      metrics: new InMemoryMetrics(),
    });

    const outcome = await watcher.handle({ ...eventFor(forged.messageId, true), fromHandle: 'hoops_iq' });
    expect(outcome.status).toBe('ignored');
  });
});

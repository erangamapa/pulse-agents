import { describe, expect, it } from 'vitest';
import { InMemoryBus, TOPICS } from '../src/events/subscriber.js';
import { silentLogger } from '../src/observability/logger.js';
import { InMemoryMetrics } from '../src/observability/metrics.js';
import { commissionOn, InMemoryLedger } from '../src/placement/ledger.js';
import { InMemoryQueue, type PlacementOrder } from '../src/placement/queue.js';
import { createPlacementWorker, PlacementUnavailableError } from '../src/placement/worker.js';
import { CircuitOpenError } from '../src/clients/circuitBreaker.js';
import { HttpError } from '../src/clients/http.js';
import type { ConfirmationVerifier } from '../src/placement/verifier.js';
import { FakeEngine } from './fakes.js';

const order = (overrides: Partial<PlacementOrder> = {}): PlacementOrder => ({
  orderId: 'order-1',
  accountId: 'acct-7',
  conversationId: 'conv-1',
  confirmationRef: 'dm:conv-1:msg-9',
  proposal: {
    state: 'confirmed',
    selections: [{ eventId: 'evt-1', marketId: 'mkt-1', selectionId: 'sel-1', price: '1.9000' }],
    stake: { currency: 'USDT', amount: '25' },
    expiresAt: '2025-03-01T12:05:00Z',
  },
  ...overrides,
});

const accepting: ConfirmationVerifier = { verify: async () => ({ ok: true }) };

const setup = (verifier: ConfirmationVerifier = accepting) => {
  const engine = new FakeEngine();
  const ledger = new InMemoryLedger(() => new Date('2025-03-01T12:00:00Z'));
  const bus = new InMemoryBus();
  const metrics = new InMemoryMetrics();
  const results: unknown[] = [];
  bus.subscribe(TOPICS.placementResults, async (payload) => void results.push(payload));
  const worker = createPlacementWorker({
    engine,
    ledger,
    verifier,
    bus,
    logger: silentLogger(),
    metrics,
    commissionBasisPoints: 200,
    now: () => Date.parse('2025-03-01T12:00:00Z'),
  });
  return { engine, ledger, worker, results, metrics };
};

describe('placement worker', () => {
  it('refuses an order that has no confirmation ref', async () => {
    const { engine, worker, results } = setup();
    const result = await worker.process(order({ confirmationRef: undefined }));

    expect(result).toMatchObject({ status: 'refused', reason: 'missing_confirmation' });
    expect(engine.placeKeys).toHaveLength(0);
    expect(results).toHaveLength(1);
  });

  it('places a confirmed order and records one commission row', async () => {
    const { engine, ledger, worker } = setup();
    const result = await worker.process(order());

    expect(result).toMatchObject({ status: 'placed', betId: 'bet-1' });
    expect(engine.placeKeys).toHaveLength(1);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      betId: 'bet-1',
      accountId: 'acct-7',
      commission: { currency: 'USDT', amount: '0.50' },
    });
  });

  it('hits the engine once when the same order arrives twice', async () => {
    const { engine, ledger, worker } = setup();
    await worker.process(order());
    await worker.process(order());

    expect(engine.placeKeys).toHaveLength(2);
    expect(new Set(engine.placeKeys).size).toBe(1);
    expect(engine.bets.size).toBe(1);
    expect(ledger.rows).toHaveLength(1);
  });

  it('refuses a proposal that is not confirmed', async () => {
    const { engine, worker } = setup();
    const base = order();
    const result = await worker.process({ ...base, proposal: { ...base.proposal, state: 'proposed' } });

    expect(result).toMatchObject({ status: 'refused', reason: 'proposal_not_confirmed' });
    expect(engine.placeKeys).toHaveLength(0);
  });

  it('refuses when the timeline does not back the confirmation ref', async () => {
    const { engine, worker, results } = setup({
      verify: async () => ({ ok: false, detail: 'order differs from the confirmed proposal' }),
    });
    const result = await worker.process(order());

    expect(result).toMatchObject({ status: 'refused', reason: 'confirmation_unverified' });
    expect(engine.placeKeys).toHaveLength(0);
    expect(results).toHaveLength(1);
  });

  it('refuses a proposal that carries no expiry', async () => {
    const { engine, worker } = setup();
    const base = order();
    const result = await worker.process({ ...base, proposal: { ...base.proposal, expiresAt: undefined } });

    expect(result).toMatchObject({ status: 'refused', reason: 'proposal_expired' });
    expect(engine.placeKeys).toHaveLength(0);
  });

  it('turns a permanent engine error into a published refusal the queue can acknowledge', async () => {
    const { engine, worker, results } = setup();
    engine.failPlacementWith = new HttpError(422, 'http://engine.internal/v1/bets');

    const result = await worker.process(order());

    expect(result).toMatchObject({ status: 'refused', reason: 'engine_error', detail: 'HttpError' });
    expect(results).toHaveLength(1);
  });

  it('refuses an expired proposal', async () => {
    const { worker } = setup();
    const base = order();
    const result = await worker.process({
      ...base,
      proposal: { ...base.proposal, expiresAt: '2025-03-01T11:59:00Z' },
    });
    expect(result).toMatchObject({ status: 'refused', reason: 'proposal_expired' });
  });

  it('refuses when the stake limit check fails', async () => {
    const { engine, worker } = setup();
    engine.stakeAllowed = false;
    const result = await worker.process(order());

    expect(result).toMatchObject({ status: 'refused', reason: 'stake_limit', detail: 'maxStakePerBet' });
    expect(engine.placeKeys).toHaveLength(0);
  });

  it('refuses when the price moved since the proposal', async () => {
    const { engine, worker } = setup();
    engine.repriced = true;
    const result = await worker.process(order());

    expect(result).toMatchObject({ status: 'refused', reason: 'price_moved' });
    expect(engine.placeKeys).toHaveLength(0);
  });

  it('raises a retryable error when the engine circuit is open', async () => {
    const { engine, worker } = setup();
    engine.failPlacementWith = new CircuitOpenError(1_000);

    await expect(worker.process(order())).rejects.toBeInstanceOf(PlacementUnavailableError);
  });

  it('consumes from the queue', async () => {
    const { engine, worker } = setup();
    const queue = new InMemoryQueue();
    queue.consume(worker.handler);
    await queue.enqueue(order());

    expect(engine.bets.size).toBe(1);
  });
});

describe('commission', () => {
  it('takes two percent with exact decimals', () => {
    expect(commissionOn({ currency: 'USDT', amount: '25' }, 200).amount).toBe('0.50');
    expect(commissionOn({ currency: 'USDT', amount: '0.01' }, 200).amount).toBe('0.0002');
    expect(commissionOn({ currency: 'USDT', amount: '19.99' }, 200).amount).toBe('0.3998');
  });
});

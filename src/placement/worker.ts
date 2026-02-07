import { idempotencyKeyFor } from 'agentloop';
import type { BettingEngine } from '../clients/bettingEngine.js';
import { CircuitOpenError } from '../clients/circuitBreaker.js';
import { HttpError } from '../clients/http.js';
import type { EventBus } from '../events/subscriber.js';
import { TOPICS } from '../events/subscriber.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { CommissionLedger } from './ledger.js';
import { isExpired } from '../dm/proposals.js';
import { placementOrder, type OrderHandler } from './queue.js';
import type { ConfirmationVerifier } from './verifier.js';

export type RefusalReason =
  | 'invalid_order'
  | 'missing_confirmation'
  | 'proposal_not_confirmed'
  | 'proposal_expired'
  | 'confirmation_unverified'
  | 'engine_error'
  | 'stake_limit'
  | 'slip_invalid'
  | 'price_moved';

export type PlacementResult =
  | { status: 'placed'; orderId: string; betId: string; confirmationRef: string }
  | { status: 'refused'; orderId: string; reason: RefusalReason; detail?: string };

export class PlacementUnavailableError extends Error {
  override readonly name = 'PlacementUnavailableError';

  constructor(options: { cause: unknown }) {
    super('The betting engine is unavailable. The order stays queued for retry.', options);
  }
}

export interface PlacementWorkerDeps {
  engine: BettingEngine;
  ledger: CommissionLedger;
  verifier: ConfirmationVerifier;
  bus: EventBus;
  logger: Logger;
  metrics: Metrics;
  commissionBasisPoints: number;
  now?: () => number;
}

export const WORKER_ACTOR = { kind: 'agent', id: 'placement-worker' } as const;

const isTransient = (error: unknown): boolean =>
  error instanceof CircuitOpenError || (error instanceof HttpError && error.retryable);

/**
 * The only code in this service that places a bet. Personas and DM experts
 * hold no placement tool. They can only stage a proposal that a person confirms.
 */
export const createPlacementWorker = (deps: PlacementWorkerDeps) => {
  const now = deps.now ?? Date.now;

  const finish = async (result: PlacementResult): Promise<PlacementResult> => {
    deps.metrics.increment('placement_results', { status: result.status });
    await deps.bus.publish(TOPICS.placementResults, result);
    return result;
  };

  const refuse = (orderId: string, reason: RefusalReason, detail?: string) => {
    deps.logger.warn({ orderId, reason, detail }, 'placement refused');
    return finish({ status: 'refused', orderId, reason, ...(detail ? { detail } : {}) });
  };

  /** Transient failures go back to the queue for retry. Anything else is final, so it is reported and acknowledged. */
  const failure = (orderId: string, error: unknown): Promise<PlacementResult> => {
    if (isTransient(error)) throw new PlacementUnavailableError({ cause: error });
    deps.logger.error({ orderId, err: error }, 'placement failed permanently');
    return refuse(orderId, 'engine_error', error instanceof Error ? error.name : 'unknown');
  };

  const handleOrder = async (raw: unknown): Promise<PlacementResult> => {
    const parsed = placementOrder.safeParse(raw);
    if (!parsed.success) {
      const orderId = typeof (raw as { orderId?: unknown })?.orderId === 'string'
        ? (raw as { orderId: string }).orderId
        : 'unknown';
      return refuse(orderId, 'invalid_order', parsed.error.issues.map((issue) => issue.message).join(' '));
    }
    const order = parsed.data;
    const { confirmationRef, proposal } = order;

    if (!confirmationRef) return refuse(order.orderId, 'missing_confirmation');
    if (proposal.state !== 'confirmed') return refuse(order.orderId, 'proposal_not_confirmed');
    if (isExpired(proposal, now())) return refuse(order.orderId, 'proposal_expired');

    let verification;
    try {
      verification = await deps.verifier.verify(order);
    } catch (error) {
      return failure(order.orderId, error);
    }
    if (!verification.ok) return refuse(order.orderId, 'confirmation_unverified', verification.detail);

    let bet;
    try {
      const limits = await deps.engine.checkStakeLimits(order.accountId, proposal.stake, proposal.selections);
      if (!limits.allowed) return refuse(order.orderId, 'stake_limit', limits.bindingLimit);

      // Odds move between the proposal and the confirmation, so the slip is priced again here.
      const slip = await deps.engine.priceSlip({
        accountId: order.accountId,
        selections: proposal.selections,
        stake: proposal.stake,
        mode: 'single',
      });
      if (!slip.valid) return refuse(order.orderId, 'slip_invalid', slip.rejections.join(' '));
      if (slip.selections.some((selection) => selection.repriced)) {
        return refuse(order.orderId, 'price_moved');
      }

      bet = await deps.engine.placeBet(
        {
          slipId: slip.slipId,
          stake: proposal.stake,
          placedBy: WORKER_ACTOR,
          onBehalfOf: order.accountId,
          confirmationRef,
        },
        idempotencyKeyFor(order.conversationId, confirmationRef),
      );
    } catch (error) {
      return failure(order.orderId, error);
    }

    try {
      await deps.ledger.record({
        betId: bet.betId,
        accountId: order.accountId,
        confirmationRef,
        stake: proposal.stake,
        rateBasisPoints: deps.commissionBasisPoints,
      });
    } catch (error) {
      // The bet exists. A retry reuses the idempotency key and the ledger writes one row per bet.
      throw new PlacementUnavailableError({ cause: error });
    }

    deps.metrics.increment('bets_placed');
    return finish({ status: 'placed', orderId: order.orderId, betId: bet.betId, confirmationRef });
  };

  const handler: OrderHandler = async (order) => {
    await handleOrder(order);
  };

  return { process: handleOrder, handler };
};

export type PlacementWorker = ReturnType<typeof createPlacementWorker>;

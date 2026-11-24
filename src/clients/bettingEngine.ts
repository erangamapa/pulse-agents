import {
  accountLimits,
  bet,
  oddsTick,
  pricedSlip,
  stakeCheckResult,
  type AccountLimits,
  type Bet,
  type Money,
  type OddsTick,
  type PlaceBetRequest,
  type PricedSlip,
  type Selection,
  type SlipDraft,
  type StakeCheckResult,
} from 'sportsbook-contracts';
import { CircuitBreaker } from './circuitBreaker.js';
import { HttpError, joinUrl, requestJson, type FetchLike } from './http.js';

export interface SelectionRef {
  eventId: string;
  marketId: string;
  selectionId: string;
}

export interface BettingEngine {
  getSelectionTick(ref: SelectionRef): Promise<OddsTick>;
  priceSlip(draft: SlipDraft): Promise<PricedSlip>;
  getAccountLimits(accountId: string): Promise<AccountLimits>;
  checkStakeLimits(accountId: string, stake: Money, selections: readonly Selection[]): Promise<StakeCheckResult>;
  placeBet(request: PlaceBetRequest, idempotencyKey: string): Promise<Bet>;
}

export interface BettingEngineOptions {
  baseUrl: string;
  fetch: FetchLike;
  breaker: CircuitBreaker;
}

const upstreamFailure = (error: unknown): boolean =>
  !(error instanceof HttpError) || error.retryable;

export const createBreakerForEngine = (
  options: ConstructorParameters<typeof CircuitBreaker>[0],
): CircuitBreaker => new CircuitBreaker({ isFailure: upstreamFailure, ...options });

export const createBettingEngineClient = ({
  baseUrl,
  fetch,
  breaker,
}: BettingEngineOptions): BettingEngine => {
  const call = <T>(operation: () => Promise<T>): Promise<T> => breaker.execute(operation);

  return {
    getSelectionTick: ({ eventId, marketId, selectionId }) =>
      call(() =>
        requestJson({
          fetch,
          url: joinUrl(
            baseUrl,
            `/v1/events/${encodeURIComponent(eventId)}/markets/${encodeURIComponent(marketId)}/selections/${encodeURIComponent(selectionId)}`,
          ),
          schema: oddsTick,
        }),
      ),

    priceSlip: (draft) =>
      call(() =>
        requestJson({
          fetch,
          url: joinUrl(baseUrl, '/v1/slips/price'),
          method: 'POST',
          body: draft,
          schema: pricedSlip,
        }),
      ),

    getAccountLimits: (accountId) =>
      call(() =>
        requestJson({
          fetch,
          url: joinUrl(baseUrl, `/v1/accounts/${encodeURIComponent(accountId)}/limits`),
          schema: accountLimits,
        }),
      ),

    checkStakeLimits: (accountId, stake, selections) =>
      call(() =>
        requestJson({
          fetch,
          url: joinUrl(baseUrl, `/v1/accounts/${encodeURIComponent(accountId)}/stake-check`),
          method: 'POST',
          body: { stake, selections },
          schema: stakeCheckResult,
        }),
      ),

    placeBet: (request, idempotencyKey) =>
      call(() =>
        requestJson({
          fetch,
          url: joinUrl(baseUrl, '/v1/bets'),
          method: 'POST',
          body: request,
          headers: { 'Idempotency-Key': idempotencyKey },
          schema: bet,
        }),
      ),
  };
};

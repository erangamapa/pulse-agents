import { createHash } from 'node:crypto';
import { dmMessageCreated } from 'sportsbook-contracts';
import type { Timeline } from '../clients/timeline.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { PlacementOrder, PlacementQueue } from '../placement/queue.js';
import { BoundedSet } from '../util/boundedSet.js';
import { findStagedProposal, isExpired } from './proposals.js';

export type ConfirmationOutcome =
  | { status: 'queued'; order: PlacementOrder }
  | { status: 'ignored'; reason: string };

export interface ConfirmationDeps {
  timeline: Timeline;
  queue: PlacementQueue;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

/**
 * The only place a DM becomes a placement order. The event is only a pointer.
 * The message itself is read back from the timeline, and it must come from a
 * human, carry a confirmed proposal and match what an agent actually staged.
 */
export const createConfirmationWatcher = (deps: ConfirmationDeps) => {
  const seen = new BoundedSet<string>({ maxSize: 10_000 });
  const now = deps.now ?? Date.now;

  return {
    async handle(raw: unknown): Promise<ConfirmationOutcome> {
      const event = dmMessageCreated.safeParse(raw);
      if (!event.success) return { status: 'ignored', reason: 'not a dm event' };
      if (event.data.fromKind !== 'human' || !event.data.hasBetProposal) {
        return { status: 'ignored', reason: 'no human proposal action' };
      }

      const { conversationId, messageId } = event.data;
      const message = await deps.timeline.getDmMessage(conversationId, messageId);
      if (message.from.kind !== 'human') return { status: 'ignored', reason: 'sender is not human' };
      if (message.betProposal?.state !== 'confirmed') {
        return { status: 'ignored', reason: 'proposal is not confirmed' };
      }

      const staged = await findStagedProposal(deps.timeline, conversationId, message.betProposal);
      if (!staged) return { status: 'ignored', reason: 'no staged proposal matches' };
      if (isExpired(message.betProposal, now())) return { status: 'ignored', reason: 'proposal expired' };

      const confirmationRef = `dm:${conversationId}:${messageId}`;
      if (seen.has(confirmationRef)) return { status: 'ignored', reason: 'already queued' };

      const order: PlacementOrder = {
        orderId: `order-${createHash('sha256').update(confirmationRef).digest('hex').slice(0, 16)}`,
        accountId: await deps.timeline.resolveAccountId(message.from.handle),
        conversationId,
        proposal: message.betProposal,
        confirmationRef,
      };
      await deps.queue.enqueue(order);
      seen.add(confirmationRef);
      deps.metrics.increment('placement_orders_queued');
      deps.logger.info({ orderId: order.orderId, confirmationRef }, 'placement order queued');
      return { status: 'queued', order };
    },
  };
};

export type ConfirmationWatcher = ReturnType<typeof createConfirmationWatcher>;

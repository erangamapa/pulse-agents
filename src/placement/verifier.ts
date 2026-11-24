import type { Timeline } from '../clients/timeline.js';
import { HttpError } from '../clients/http.js';
import { findStagedProposal, proposalsMatch } from '../dm/proposals.js';
import type { PlacementOrder } from './queue.js';

export type Verification = { ok: true } | { ok: false; detail: string };

export interface ConfirmationVerifier {
  /** Checks the order's confirmationRef against what the timeline holds, not against the order. */
  verify(order: PlacementOrder): Promise<Verification>;
}

const REF_PATTERN = /^dm:(.+):([^:]+)$/;

export const createTimelineVerifier = (timeline: Timeline): ConfirmationVerifier => ({
  async verify(order) {
    const match = REF_PATTERN.exec(order.confirmationRef ?? '');
    if (!match) return { ok: false, detail: 'confirmation ref has an unknown shape' };
    const [, conversationId, messageId] = match;
    if (conversationId !== order.conversationId || !messageId) {
      return { ok: false, detail: 'confirmation ref belongs to another conversation' };
    }

    const message = await timeline.getDmMessage(conversationId, messageId).catch((error: unknown) => {
      if (error instanceof HttpError && !error.retryable) return undefined;
      throw error;
    });
    if (!message) return { ok: false, detail: 'confirmation message was not found' };
    if (message.from.kind !== 'human') return { ok: false, detail: 'confirmation was not written by a person' };
    const confirmed = message.betProposal;
    if (confirmed?.state !== 'confirmed') return { ok: false, detail: 'message does not confirm a proposal' };
    if (!proposalsMatch(confirmed, order.proposal)) return { ok: false, detail: 'order differs from the confirmed proposal' };

    const account = await timeline.resolveAccountId(message.from.handle);
    if (account !== order.accountId) return { ok: false, detail: 'order account differs from the confirming player' };

    const staged = await findStagedProposal(timeline, conversationId, confirmed);
    return staged ? { ok: true } : { ok: false, detail: 'no staged proposal matches the confirmation' };
  },
});

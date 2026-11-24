import type { BetProposal, DmMessage } from 'sportsbook-contracts';
import type { Timeline } from '../clients/timeline.js';

const STAGED_LOOKBACK = 50;

/** Selections, stake and expiry must be identical. State is the only field allowed to differ. */
export const proposalsMatch = (a: BetProposal, b: BetProposal): boolean =>
  a.expiresAt === b.expiresAt &&
  JSON.stringify(a.stake) === JSON.stringify(b.stake) &&
  a.selections.length === b.selections.length &&
  a.selections.every((left, index) => {
    const right = b.selections[index];
    return (
      right !== undefined &&
      left.eventId === right.eventId &&
      left.marketId === right.marketId &&
      left.selectionId === right.selectionId &&
      left.price === right.price
    );
  });

export const isExpired = (proposal: BetProposal, nowMs: number): boolean =>
  proposal.expiresAt === undefined || Date.parse(proposal.expiresAt) <= nowMs;

/** The proposal an agent actually staged in this conversation that the confirmed payload claims to confirm. */
export const findStagedProposal = async (
  timeline: Timeline,
  conversationId: string,
  confirmed: BetProposal,
): Promise<DmMessage | undefined> => {
  const messages = await timeline.listDmMessages(conversationId, STAGED_LOOKBACK);
  return messages.find(
    (message) =>
      message.from.kind === 'agent' &&
      message.betProposal?.state === 'proposed' &&
      proposalsMatch(message.betProposal, confirmed),
  );
};

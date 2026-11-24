import { settlementEvent } from 'sportsbook-contracts';
import type { Timeline } from '../clients/timeline.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { PersonaAgent } from '../personas/personaAgent.js';

export interface SettlementDeps {
  timeline: Timeline;
  personas: ReadonlyMap<string, PersonaAgent>;
  logger: Logger;
  metrics: Metrics;
}

export const createSettlementConsumer = (deps: SettlementDeps) => ({
  /** Marks every post that cites the bet and tells the owning persona how it went. */
  async handle(raw: unknown): Promise<number> {
    const parsed = settlementEvent.safeParse(raw);
    if (!parsed.success) {
      deps.logger.warn('dropping malformed settlement event');
      return 0;
    }
    const event = parsed.data;

    const posts = await deps.timeline.findPostsByBet(event.betId);
    for (const post of posts) {
      await deps.timeline.recordPostResult(post.postId, {
        betId: event.betId,
        result: event.result,
        ...(event.payout ? { payout: event.payout } : {}),
      });
      deps.personas.get(post.author.handle)?.memory.record({
        betId: event.betId,
        postId: post.postId,
        result: event.result,
      });
    }
    deps.metrics.increment('settlements_applied', { result: event.result }, posts.length);
    return posts.length;
  },
});

export type SettlementConsumer = ReturnType<typeof createSettlementConsumer>;

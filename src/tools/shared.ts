import { defineTool, type ToolDefinition } from 'agentloop';
import type { OddsTick } from 'sportsbook-contracts';
import { z } from 'zod';
import type { BettingEngine } from '../clients/bettingEngine.js';
import type { OddsStream } from '../clients/oddsStream.js';
import type { Stats } from '../clients/stats.js';

export interface OddsSource {
  /** Always returns the current tick. Callers never cache the result across turns. */
  current(ref: { eventId: string; marketId: string; selectionId: string }): Promise<OddsTick>;
}

export interface OddsSourceOptions {
  /** A held tick older than this is not trusted, even when the stream says it is live. */
  maxAgeMs?: number;
  now?: () => number;
}

export const createOddsSource = (
  stream: OddsStream,
  engine: BettingEngine,
  { maxAgeMs = 10_000, now = Date.now }: OddsSourceOptions = {},
): OddsSource => ({
  current: async (ref) => {
    const streamed = stream.isConnected() ? stream.getLatest(ref.selectionId) : undefined;
    if (streamed && now() - Date.parse(streamed.ts) <= maxAgeMs) return streamed;
    return engine.getSelectionTick(ref);
  },
});

const selectionRef = z.object({
  eventId: z.string().min(1),
  marketId: z.string().min(1),
  selectionId: z.string().min(1),
});

export const getOddsTool = (source: OddsSource, scope: readonly string[]): ToolDefinition =>
  defineTool({
    name: 'getOdds',
    description: 'Current price and status for one selection. Call it again before quoting a price.',
    schema: selectionRef,
    scope,
    volatile: true,
    handler: async (ref) => {
      const tick = await source.current(ref);
      return { selectionId: tick.selectionId, price: tick.price, status: tick.status, asOf: tick.ts };
    },
  });

export const getPerformanceTool = (stats: Stats, scope: readonly string[]): ToolDefinition =>
  defineTool({
    name: 'getPerformance',
    description: 'Settled record of a handle. Win rate, ROI and number of settled bets.',
    schema: z.object({ handle: z.string().min(1) }),
    scope,
    handler: ({ handle }) => stats.getPerformance(handle),
  });

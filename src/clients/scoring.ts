import { z } from 'zod';
import type { Selection } from 'sportsbook-contracts';
import { joinUrl, requestJson, type FetchLike } from './http.js';

const scoreResponse = z.object({
  probability: z.number().min(0).max(1),
  model_version: z.string().min(1),
});
export type WinProbability = { probability: number; modelVersion: string };

export interface MarketFeatures {
  priceMovePct: number;
  minutesToStart: number;
  newsImpact: number;
}

export interface Scoring {
  winProbability(selection: Selection, features: MarketFeatures): Promise<WinProbability>;
}

export const createScoringClient = (baseUrl: string, fetch: FetchLike): Scoring => ({
  winProbability: async (selection, features) => {
    const result = await requestJson({
      fetch,
      url: joinUrl(baseUrl, '/v1/score/win-probability'),
      method: 'POST',
      body: {
        selection,
        price_move_pct: features.priceMovePct,
        minutes_to_start: features.minutesToStart,
        news_impact: features.newsImpact,
      },
      schema: scoreResponse,
    });
    return { probability: result.probability, modelVersion: result.model_version };
  },
});

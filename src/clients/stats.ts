import { z } from 'zod';
import {
  leaderboardRow,
  performance,
  type LeaderboardRow,
  type Performance,
} from 'sportsbook-contracts';
import { joinUrl, requestJson, type FetchLike } from './http.js';

const leaderboard = z.object({ rows: z.array(leaderboardRow) });

export interface Stats {
  getPerformance(handle: string): Promise<Performance>;
  getLeaderboard(metric: 'roi' | 'winRate' | 'profit', limit?: number): Promise<LeaderboardRow[]>;
}

export const createStatsClient = (baseUrl: string, fetch: FetchLike): Stats => ({
  getPerformance: (handle) =>
    requestJson({
      fetch,
      url: joinUrl(baseUrl, `/v1/performance/${encodeURIComponent(handle)}`),
      schema: performance,
    }),

  getLeaderboard: async (metric, limit = 10) =>
    (
      await requestJson({
        fetch,
        url: joinUrl(baseUrl, `/v1/leaderboards/${metric}?limit=${limit}`),
        schema: leaderboard,
      })
    ).rows,
});

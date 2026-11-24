import { z } from 'zod';

export const marketSignal = z.object({
  newsId: z.string().min(1),
  sport: z.enum(['basketball', 'football', 'mma']),
  category: z.enum(['injury', 'lineup', 'suspension', 'weather', 'transfer', 'odds_move', 'other']),
  headline: z.string().min(1).max(240),
  direction: z.enum(['favours_home', 'favours_away', 'neutral']),
  confidence: z.number().min(0).max(1),
  selections: z
    .array(
      z.object({
        eventId: z.string().min(1),
        marketId: z.string().min(1),
        selectionId: z.string().min(1),
      }),
    )
    .max(10)
    .default([]),
});
export type MarketSignal = z.infer<typeof marketSignal>;

export type SignalParse =
  | { ok: true; signal: MarketSignal }
  | { ok: false; reason: string };

const stripFence = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

/** The classifier is a model, so its output is untrusted until it parses. */
export const parseMarketSignal = (raw: unknown): SignalParse => {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(stripFence(raw));
    } catch {
      return { ok: false, reason: 'classifier output is not json' };
    }
  }
  const parsed = marketSignal.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; '),
    };
  }
  return { ok: true, signal: parsed.data };
};

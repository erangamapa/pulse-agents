import { describe, expect, it } from 'vitest';
import { createAnalystAgent } from '../src/analyst/analystAgent.js';
import { parseMarketSignal, type MarketSignal } from '../src/analyst/signal.js';
import { InMemoryMetrics } from '../src/observability/metrics.js';
import { FakeOdds, NOW, tick } from './fakes.js';
import { ScriptedModel, finalAnswer, routerFor } from './scriptedModel.js';

const signal = (newsId: string): MarketSignal => ({
  newsId,
  sport: 'basketball',
  category: 'injury',
  headline: 'Starting guard ruled out',
  direction: 'favours_away',
  confidence: 0.9,
  selections: [{ eventId: 'evt-1', marketId: 'mkt-1', selectionId: 'sel-1' }],
});

const setup = (answers: string[]) => {
  const odds = new FakeOdds();
  odds.set(tick('sel-1', { price: '2.2000' }));
  const model = new ScriptedModel(answers.map(finalAnswer));
  const metrics = new InMemoryMetrics();
  const analyst = createAnalystAgent({
    router: routerFor(model),
    odds,
    scoring: { winProbability: async () => ({ probability: 0.5, modelVersion: 'fixture' }) },
    metrics,
    now: () => new Date(NOW),
  });
  return { analyst, model, metrics, odds };
};

describe('analyst', () => {
  it('produces one brief per newsId even when personas ask at the same time', async () => {
    const { analyst, model, metrics } = setup(['Away side price should shorten.', 'A different answer.']);

    const briefs = await Promise.all([analyst.brief(signal('n-1')), analyst.brief(signal('n-1')), analyst.brief(signal('n-1'))]);
    const later = await analyst.brief(signal('n-1'));

    expect(model.calls).toBe(1);
    expect(new Set(briefs.map((brief) => brief.text)).size).toBe(1);
    expect(later.text).toBe('Away side price should shorten.');
    expect(metrics.counter('analyst_cache_hits')).toBe(1);
    expect(analyst.briefFor('n-1')?.text).toBe(later.text);
  });

  it('runs again for a different newsId', async () => {
    const { analyst, model } = setup(['First.', 'Second.']);
    await analyst.brief(signal('n-1'));
    const second = await analyst.brief(signal('n-2'));

    expect(model.calls).toBe(2);
    expect(second.text).toBe('Second.');
  });

  it('verifies against live odds at brief time', async () => {
    const { analyst, odds } = setup(['Done.']);
    const brief = await analyst.brief(signal('n-1'));

    expect(odds.requests).toContain('sel-1');
    expect(brief.oddsSnapshot).toEqual([{ selectionId: 'sel-1', price: '2.2000', status: 'active', asOf: NOW }]);
  });

  it('does not cache a failed run', async () => {
    const { analyst } = setup([]);
    await expect(analyst.brief(signal('n-9'))).rejects.toThrow();
    expect(analyst.briefFor('n-9')).toBeUndefined();
  });
});

describe('market signal parsing', () => {
  it('accepts fenced json from the classifier', () => {
    const result = parseMarketSignal(`\`\`\`json\n${JSON.stringify(signal('n-1'))}\n\`\`\``);
    expect(result.ok).toBe(true);
  });

  it('rejects prose, unknown sports and out of range confidence', () => {
    expect(parseMarketSignal('The guard is out.').ok).toBe(false);
    expect(parseMarketSignal({ ...signal('n-1'), sport: 'curling' }).ok).toBe(false);
    expect(parseMarketSignal({ ...signal('n-1'), confidence: 1.4 }).ok).toBe(false);
  });
});

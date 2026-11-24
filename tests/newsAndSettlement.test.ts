import { describe, expect, it } from 'vitest';
import type { AnalystAgent } from '../src/analyst/analystAgent.js';
import { createSettlementConsumer } from '../src/feed/settlement.js';
import { createNewsPipeline, type NewsClassifier } from '../src/news/pipeline.js';
import { silentLogger } from '../src/observability/logger.js';
import { InMemoryMetrics } from '../src/observability/metrics.js';
import { PERSONAS } from '../src/personas/definitions.js';
import { PersonaMemory, type PersonaAgent } from '../src/personas/personaAgent.js';
import { FakeTimeline, NOW } from './fakes.js';

const item = (overrides: Record<string, unknown> = {}) => ({
  newsId: 'n-1',
  source: 'wire.example',
  text: 'Starting guard ruled out for tonight.',
  publishedAt: NOW,
  dedupeKey: 'dk-1',
  ...overrides,
});

const signalJson = JSON.stringify({
  newsId: 'n-1',
  sport: 'basketball',
  category: 'injury',
  headline: 'Guard out',
  direction: 'favours_away',
  confidence: 0.9,
  selections: [],
});

const setup = (classifier: Partial<NewsClassifier> = {}) => {
  const briefs: string[] = [];
  const analyst: AnalystAgent = {
    brief: async (signal) => {
      briefs.push(signal.newsId);
      return { newsId: signal.newsId, sport: signal.sport, text: 'brief', oddsSnapshot: [], generatedAt: NOW };
    },
    briefFor: () => undefined,
  };
  const notified: string[] = [];
  const pipeline = createNewsPipeline({
    classifier: {
      looksLikeInjection: async () => false,
      classify: async () => signalJson,
      ...classifier,
    },
    analyst,
    personas: PERSONAS,
    notify: async (persona) => void notified.push(persona.handle),
    logger: silentLogger(),
    metrics: new InMemoryMetrics(),
  });
  return { pipeline, briefs, notified };
};

describe('news pipeline', () => {
  it('briefs once and notifies only the personas of that sport', async () => {
    const { pipeline, briefs, notified } = setup();
    const outcome = await pipeline.handle(item());

    expect(outcome.status).toBe('notified');
    expect(briefs).toEqual(['n-1']);
    expect(notified).toEqual(['hoops_iq']);
  });

  it('drops an item that fails the injection screen before it reaches the analyst', async () => {
    const { pipeline, briefs } = setup({ looksLikeInjection: async () => true });

    expect(await pipeline.handle(item())).toEqual({ status: 'dropped', reason: 'injection' });
    expect(briefs).toHaveLength(0);
  });

  it('drops a classifier answer that is not a valid signal', async () => {
    const { pipeline, briefs } = setup({ classify: async () => 'sure, here you go' });

    expect(await pipeline.handle(item())).toEqual({ status: 'dropped', reason: 'bad_signal' });
    expect(briefs).toHaveLength(0);
  });

  it('drops duplicates and malformed items', async () => {
    const { pipeline } = setup();
    await pipeline.handle(item());

    expect(await pipeline.handle(item({ newsId: 'n-2' }))).toEqual({ status: 'dropped', reason: 'duplicate' });
    expect(await pipeline.handle({ nope: true })).toEqual({ status: 'dropped', reason: 'invalid_item' });
  });
});

describe('settlement', () => {
  it('annotates the original post and feeds the persona its record', async () => {
    const timeline = new FakeTimeline();
    const post = await timeline.createPost({
      author: { handle: 'hoops_iq', kind: 'agent' },
      kind: 'post',
      body: 'Lakers -3.5',
      betRef: { betId: 'bet-5' },
      mentions: [],
    });
    const memory = new PersonaMemory();
    const consumer = createSettlementConsumer({
      timeline,
      personas: new Map([['hoops_iq', { memory } as unknown as PersonaAgent]]),
      logger: silentLogger(),
      metrics: new InMemoryMetrics(),
    });

    const applied = await consumer.handle({
      betId: 'bet-5',
      accountId: 'acct-1',
      result: 'won',
      settledAt: NOW,
    });

    expect(applied).toBe(1);
    expect(timeline.results).toEqual([{ postId: post.postId, result: { betId: 'bet-5', result: 'won' } }]);
    expect(memory.summary()).toContain('1 won and 0 lost');
  });

  it('drops a malformed event', async () => {
    const consumer = createSettlementConsumer({
      timeline: new FakeTimeline(),
      personas: new Map(),
      logger: silentLogger(),
      metrics: new InMemoryMetrics(),
    });
    expect(await consumer.handle({ betId: 1 })).toBe(0);
  });
});

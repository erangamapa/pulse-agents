import { describe, expect, it } from 'vitest';
import type { OddsTick } from 'sportsbook-contracts';
import { OddsStreamClient, parseSse } from '../src/clients/oddsStream.js';
import { silentLogger } from '../src/observability/logger.js';
import { InMemoryMetrics } from '../src/observability/metrics.js';
import { tick } from './fakes.js';

const stream = (options: { maxPending?: number } = {}) =>
  new OddsStreamClient({
    url: 'http://odds.internal/stream',
    fetch: async () => {
      throw new Error('no network in tests');
    },
    logger: silentLogger(),
    metrics: new InMemoryMetrics(),
    ...options,
  });

describe('odds stream', () => {
  it('coalesces to one tick per selection and getLatest returns the newest seq', () => {
    const odds = stream();
    const delivered: OddsTick[][] = [];
    odds.subscribe((ticks) => delivered.push([...ticks]));

    odds.ingest(tick('sel-1', { seq: 1, price: '1.9000' }));
    odds.ingest(tick('sel-1', { seq: 2, price: '1.8500' }));
    odds.ingest(tick('sel-1', { seq: 3, price: '1.8000' }));
    odds.ingest(tick('sel-2', { seq: 1, price: '3.1000' }));
    odds.flush();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.map((value) => [value.selectionId, value.seq])).toEqual([
      ['sel-1', 3],
      ['sel-2', 1],
    ]);
    expect(odds.getLatest('sel-1')?.price).toBe('1.8000');
  });

  it('drops a tick that arrives with an older seq', () => {
    const odds = stream();
    odds.ingest(tick('sel-1', { seq: 5, price: '1.7000' }));
    odds.ingest(tick('sel-1', { seq: 4, price: '2.0000' }));

    expect(odds.getLatest('sel-1')?.seq).toBe(5);
  });

  it('marks a selection suspended and clears it when trading resumes', () => {
    const odds = stream();
    odds.ingest(tick('sel-1', { seq: 1 }));
    expect(odds.isSuspended('sel-1')).toBe(false);

    odds.ingest(tick('sel-1', { seq: 2, status: 'suspended' }));
    expect(odds.isSuspended('sel-1')).toBe(true);
    expect(odds.getLatest('sel-1')?.status).toBe('suspended');

    odds.ingest(tick('sel-1', { seq: 3 }));
    expect(odds.isSuspended('sel-1')).toBe(false);
  });

  it('bounds the pending buffer and counts what it dropped', () => {
    const odds = stream({ maxPending: 2 });
    const delivered: OddsTick[][] = [];
    odds.subscribe((ticks) => delivered.push([...ticks]));
    for (const id of ['a', 'b', 'c', 'd']) odds.ingest(tick(id));
    odds.flush();

    expect(delivered[0]?.map((value) => value.selectionId)).toEqual(['c', 'd']);
    expect(odds.droppedCount).toBe(2);
    expect(odds.getLatest('a')).toBeDefined();
  });

  it('remembers the last event id for resume', () => {
    const odds = stream();
    odds.ingest(tick('sel-1', { seq: 1 }), 'evt-41');
    expect(odds.lastSeenEventId).toBe('evt-41');
  });
});

describe('sse parser', () => {
  it('parses ids, events and multi line data across chunk boundaries', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': keepalive\nid: 7\nevent: tick\nda'));
        controller.enqueue(encoder.encode('ta: {"a":1}\ndata: {"b":2}\n\nid: 8\ndata: x\n\n'));
        controller.close();
      },
    });

    const messages = [];
    for await (const message of parseSse(body)) messages.push(message);

    expect(messages).toEqual([
      { id: '7', event: 'tick', data: '{"a":1}\n{"b":2}' },
      { id: '8', data: 'x' },
    ]);
  });
});

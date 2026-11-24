import { oddsTick, type OddsTick } from 'sportsbook-contracts';
import type { FetchLike } from './http.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';

export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
}

/** Minimal server sent events parser. Comment lines and unknown fields are ignored. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buffer = '';
  let pending: { id?: string; event?: string; data: string[] } = { data: [] };

  const flush = (): SseMessage | undefined => {
    if (pending.data.length === 0) {
      pending = { data: [] };
      return undefined;
    }
    const message: SseMessage = {
      data: pending.data.join('\n'),
      ...(pending.id !== undefined ? { id: pending.id } : {}),
      ...(pending.event !== undefined ? { event: pending.event } : {}),
    };
    pending = { data: [] };
    return message;
  };

  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line === '') {
        const message = flush();
        if (message) yield message;
      } else if (!line.startsWith(':')) {
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        const content = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
        if (field === 'data') pending.data.push(content);
        else if (field === 'id') pending.id = content;
        else if (field === 'event') pending.event = content;
      }
      newline = buffer.indexOf('\n');
    }
  }
}

export type TickListener = (ticks: readonly OddsTick[]) => void;

export interface OddsStreamOptions {
  url: string;
  fetch: FetchLike;
  logger: Logger;
  metrics: Metrics;
  /** Upper bound on selections waiting to be delivered to subscribers. */
  maxPending?: number;
  /** Upper bound on selections kept for getLatest. */
  maxTracked?: number;
  flushIntervalMs?: number;
  reconnectDelayMs?: number;
}

export interface OddsStream {
  getLatest(selectionId: string): OddsTick | undefined;
  isSuspended(selectionId: string): boolean;
  isConnected(): boolean;
  subscribe(listener: TickListener): () => void;
}

/**
 * Keeps only the newest tick per selection. Slow consumers see fewer, fresher
 * ticks instead of a growing queue. A tick with a lower seq than what is held
 * is stale and dropped, which also covers replays after a reconnect.
 */
export class OddsStreamClient implements OddsStream {
  private readonly latest = new Map<string, OddsTick>();
  private readonly pending = new Map<string, OddsTick>();
  private readonly listeners = new Set<TickListener>();
  private readonly maxPending: number;
  private readonly maxTracked: number;
  private lastEventId: string | undefined;
  private abort: AbortController | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private droppedPending = 0;
  private connected = false;

  constructor(private readonly options: OddsStreamOptions) {
    this.maxPending = options.maxPending ?? 1_000;
    this.maxTracked = options.maxTracked ?? 50_000;
  }

  get lastSeenEventId(): string | undefined {
    return this.lastEventId;
  }

  get droppedCount(): number {
    return this.droppedPending;
  }

  getLatest(selectionId: string): OddsTick | undefined {
    return this.latest.get(selectionId);
  }

  isConnected(): boolean {
    return this.connected;
  }

  isSuspended(selectionId: string): boolean {
    return this.latest.get(selectionId)?.status === 'suspended';
  }

  subscribe(listener: TickListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ingest(tick: OddsTick, eventId?: string): void {
    if (eventId !== undefined) this.lastEventId = eventId;
    const held = this.latest.get(tick.selectionId);
    if (held && held.seq >= tick.seq) {
      this.options.metrics.increment('odds_ticks_stale');
      return;
    }

    this.latest.delete(tick.selectionId);
    this.latest.set(tick.selectionId, tick);
    this.evictOldest(this.latest, this.maxTracked);

    this.pending.delete(tick.selectionId);
    this.pending.set(tick.selectionId, tick);
    this.droppedPending += this.evictOldest(this.pending, this.maxPending);
  }

  /** Hands every pending tick to subscribers once, then clears the buffer. */
  flush(): void {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const listener of this.listeners) {
      try {
        listener(batch);
      } catch (error) {
        this.options.logger.error({ err: error }, 'odds listener failed');
      }
    }
  }

  start(): void {
    if (this.abort) return;
    this.abort = new AbortController();
    this.flushTimer = setInterval(() => this.flush(), this.options.flushIntervalMs ?? 100);
    void this.run(this.abort.signal);
  }

  stop(): void {
    this.abort?.abort();
    this.connected = false;
    this.abort = undefined;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
  }

  private evictOldest(map: Map<string, OddsTick>, limit: number): number {
    let evicted = 0;
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
      evicted += 1;
    }
    return evicted;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.consume(signal);
      } catch (error) {
        this.connected = false;
        if (signal.aborted) return;
        this.options.logger.warn({ err: error }, 'odds stream dropped, reconnecting');
        this.options.metrics.increment('odds_stream_reconnects');
      }
      this.connected = false;
      await new Promise((resolve) => setTimeout(resolve, this.options.reconnectDelayMs ?? 1_000));
    }
  }

  private async consume(signal: AbortSignal): Promise<void> {
    const response = await this.options.fetch(this.options.url, {
      headers: {
        accept: 'text/event-stream',
        ...(this.lastEventId !== undefined ? { 'Last-Event-ID': this.lastEventId } : {}),
      },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Odds stream answered ${response.status}.`);
    }
    this.connected = true;
    for await (const message of parseSse(response.body)) {
      const parsed = oddsTick.safeParse(safeJson(message.data));
      if (!parsed.success) {
        this.options.metrics.increment('odds_ticks_invalid');
        continue;
      }
      this.ingest(parsed.data, message.id);
    }
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

import { createHash, timingSafeEqual } from 'node:crypto';
import { BoundedSet } from './util/boundedSet.js';

export interface InternalRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface InternalResponse {
  status: number;
  body: unknown;
}

export interface InternalRouteDeps {
  authToken: string;
  deliverPlacement(order: unknown): Promise<void>;
  runCron(): Promise<string[]>;
  now?: () => number;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Hashing first gives both sides equal length, so the compare is constant time for any input. */
export const tokenMatches = (supplied: string | undefined, expected: string): boolean =>
  timingSafeEqual(digest(supplied ?? ''), digest(expected)) && supplied !== undefined;

const bearerOf = (header: string | string[] | undefined): string | undefined => {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined;
};

const headerOf = (header: string | string[] | undefined): string | undefined =>
  Array.isArray(header) ? header[0] : header;

export const INTERNAL_PATHS = ['/internal/placements', '/internal/cron/tick'] as const;

/**
 * Routes only the platform may call. Both need the shared secret, because a
 * placement payload is an instruction to move money.
 */
export const createInternalRoutes = (deps: InternalRouteDeps) => {
  const now = deps.now ?? Date.now;
  // Cloud Tasks already refuses to create two tasks with one name. This covers the
  // other side, the same named task being pushed to us twice. A name is remembered
  // only after the worker succeeds, so a failed attempt can still be retried.
  const finished = new BoundedSet<string>({ maxSize: 10_000, ttlMs: 60 * 60_000, now });
  const running = new Set<string>();

  return {
    async handle(request: InternalRequest): Promise<InternalResponse | undefined> {
      if (request.method !== 'POST' || !(INTERNAL_PATHS as readonly string[]).includes(request.url)) {
        return undefined;
      }
      if (!tokenMatches(bearerOf(request.headers.authorization), deps.authToken)) {
        return { status: 401, body: { error: 'unauthorized' } };
      }

      if (request.url === '/internal/cron/tick') {
        return { status: 200, body: { dispatched: await deps.runCron() } };
      }

      const taskName = headerOf(request.headers['x-task-name']);
      if (taskName && (finished.has(taskName) || running.has(taskName))) {
        return { status: 200, body: { accepted: true, duplicate: true } };
      }
      if (taskName) running.add(taskName);
      try {
        await deps.deliverPlacement(request.body);
        if (taskName) finished.add(taskName);
      } finally {
        if (taskName) running.delete(taskName);
      }
      return { status: 202, body: { accepted: true } };
    },
  };
};

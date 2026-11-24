import type { z } from 'zod';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`Request to ${url} failed with status ${status}.`);
  }

  get retryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

export class ResponseShapeError extends Error {
  override readonly name = 'ResponseShapeError';

  constructor(
    readonly url: string,
    readonly issues: readonly string[],
  ) {
    super(`Response from ${url} did not match the contract. ${issues.join(' ')}`);
  }
}

export interface JsonRequest<S extends z.ZodTypeAny> {
  fetch: FetchLike;
  url: string;
  schema: S;
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** Every response is parsed against its contract. Nothing unvalidated leaves a client. */
export const requestJson = async <S extends z.ZodTypeAny>({
  fetch,
  url,
  schema,
  method = 'GET',
  body,
  headers = {},
  timeoutMs = 10_000,
}: JsonRequest<S>): Promise<z.infer<S>> => {
  const response = await fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new HttpError(response.status, url);

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ResponseShapeError(
      url,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'} ${issue.message}.`),
    );
  }
  return parsed.data;
};

export const joinUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

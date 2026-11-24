import { randomUUID } from 'node:crypto';
import { pino, type Logger } from 'pino';

export type { Logger } from 'pino';

export const createLogger = (level: string = 'info'): Logger =>
  pino({
    level,
    base: { service: 'pulse-agents' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

export const requestIdFrom = (header: string | string[] | undefined): string => {
  const supplied = Array.isArray(header) ? header[0] : header;
  return supplied && /^[\w-]{8,64}$/.test(supplied) ? supplied : randomUUID();
};

export const withRequestId = (logger: Logger, requestId: string): Logger =>
  logger.child({ requestId });

export const silentLogger = (): Logger => pino({ level: 'silent' });

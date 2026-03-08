import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { PubSub } from '@google-cloud/pubsub';
import { DEFAULT_ROUTER_POLICY, ModelRouter, providersFromEnv } from 'agentloop';
import { createAnalystAgent } from './analyst/analystAgent.js';
import { createBettingEngineClient, createBreakerForEngine } from './clients/bettingEngine.js';
import { OddsStreamClient } from './clients/oddsStream.js';
import { createScoringClient } from './clients/scoring.js';
import { createStatsClient } from './clients/stats.js';
import { createTimelineClient } from './clients/timeline.js';
import { loadConfig, type Config } from './config.js';
import { createConfirmationWatcher } from './dm/confirmations.js';
import { createDmDesk, EXPERTS } from './dm/dmAgent.js';
import { PubSubBus, TOPICS, type EventBus, type Subscription } from './events/subscriber.js';
import { createMentionConsumer, ThreadEtiquette } from './feed/mentions.js';
import { createSettlementConsumer } from './feed/settlement.js';
import { createThreadReplier } from './feed/threads.js';
import { createModelClassifier, createNewsPipeline } from './news/pipeline.js';
import { createLogger, requestIdFrom, withRequestId, type Logger } from './observability/logger.js';
import { InMemoryMetrics } from './observability/metrics.js';
import { PERSONAS } from './personas/definitions.js';
import { createPersonaAgent } from './personas/personaAgent.js';
import type { Responder } from './personas/responder.js';
import { nextSlots } from './personas/scheduler.js';
import { InMemoryLedger } from './placement/ledger.js';
import { CloudTasksQueue, TokenBucket, type TaskDispatcher } from './placement/queue.js';
import { createPlacementWorker } from './placement/worker.js';
import { createTimelineVerifier } from './placement/verifier.js';
import { createOddsSource } from './tools/shared.js';
import { createInternalRoutes } from './internalRoutes.js';

export interface Service {
  server: Server;
  shutdown(): Promise<void>;
}

/** Cloud Tasks is reached through an http endpoint in this deployment, kept behind one small interface. */
const httpTaskDispatcher = (selfUrl: string, authToken: string): TaskDispatcher => ({
  createTask: async ({ name, body }) => {
    const response = await fetch(`${selfUrl}/internal/placements`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authToken}`,
        'x-task-name': name,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Task dispatch failed with status ${response.status}.`);
  },
});

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

export const startService = (config: Config, logger: Logger): Service => {
  const metrics = new InMemoryMetrics();
  const bus: EventBus = new PubSubBus(new PubSub({ projectId: config.GCP_PROJECT_ID }), logger);

  const router = new ModelRouter(
    DEFAULT_ROUTER_POLICY,
    providersFromEnv({
      ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: config.OPENAI_API_KEY,
      VLLM_BASE_URL: config.VLLM_BASE_URL,
    }),
  );

  const engine = createBettingEngineClient({
    baseUrl: config.BETTING_ENGINE_URL,
    fetch,
    breaker: createBreakerForEngine({
      failureThreshold: config.BREAKER_FAILURE_THRESHOLD,
      resetMs: config.BREAKER_RESET_MS,
    }),
  });
  const timeline = createTimelineClient(config.TIMELINE_URL, fetch);
  const stats = createStatsClient(config.STATS_URL, fetch);
  const scoring = createScoringClient(config.SCORING_URL, fetch);
  const oddsStream = new OddsStreamClient({ url: config.ODDS_STREAM_URL, fetch, logger, metrics });
  const odds = createOddsSource(oddsStream, engine, { maxAgeMs: config.ODDS_MAX_AGE_MS });

  const analyst = createAnalystAgent({ router, odds, scoring, metrics });
  const personaAgents = new Map(
    PERSONAS.map((persona) => [
      persona.handle,
      createPersonaAgent(persona, { router, odds, stats, timeline, analyst, metrics }),
    ]),
  );
  const desk = createDmDesk({ router, odds, stats, timeline, metrics, logger });

  const responders = new Map<string, Responder>(personaAgents);
  for (const expert of EXPERTS) {
    const responder = desk.responderFor(expert.handle);
    if (responder) responders.set(expert.handle, responder);
  }

  const placementQueue = new CloudTasksQueue(
    httpTaskDispatcher(`http://127.0.0.1:${config.PORT}`, config.TASKS_AUTH_TOKEN),
    new TokenBucket(config.PLACEMENT_RATE_PER_SECOND),
    new TokenBucket(config.PLACEMENT_RATE_PER_SECOND),
  );
  const worker = createPlacementWorker({
    engine,
    ledger: new InMemoryLedger(),
    verifier: createTimelineVerifier(timeline),
    bus,
    logger,
    metrics,
    commissionBasisPoints: config.COMMISSION_BPS,
  });
  const confirmations = createConfirmationWatcher({ timeline, queue: placementQueue, logger, metrics });

  const mentions = createMentionConsumer({
    responders,
    etiquette: new ThreadEtiquette({
      maxThreadReplies: config.MAX_THREAD_REPLIES,
      cooldownMs: config.THREAD_COOLDOWN_MS,
      hopBudget: config.AGENT_HOP_BUDGET,
    }),
    replier: createThreadReplier({ timeline, logger, metrics }),
    logger,
    metrics,
  });
  const settlements = createSettlementConsumer({ timeline, personas: personaAgents, logger, metrics });
  const news = createNewsPipeline({
    classifier: createModelClassifier(router),
    analyst,
    personas: PERSONAS,
    notify: async (persona, brief) => {
      await personaAgents.get(persona.handle)?.compose(brief.text.slice(0, 120), `news-${brief.newsId}`, brief);
    },
    logger,
    metrics,
  });

  const consumer = placementQueue.consume(worker.handler);
  const subscriptions: Subscription[] = [
    bus.subscribe(TOPICS.mentions, async (payload) => void (await mentions.handle(payload))),
    bus.subscribe(TOPICS.directMessages, async (payload) => {
      await confirmations.handle(payload);
      await desk.handleMessage(payload);
    }),
    bus.subscribe(TOPICS.news, async (payload) => void (await news.handle(payload))),
    bus.subscribe(TOPICS.settlements, async (payload) => void (await settlements.handle(payload))),
  ];
  oddsStream.start();

  const internal = createInternalRoutes({
    authToken: config.TASKS_AUTH_TOKEN,
    deliverPlacement: (order) => placementQueue.deliver(order),
    runCron: async () => {
      const now = Date.now();
      const due = nextSlots(PERSONAS, now - 60_000, now);
      await Promise.allSettled(
        due.map((slot) =>
          personaAgents.get(slot.handle)?.compose('what is moving in your sport today', `slot-${slot.slot}`),
        ),
      );
      return due.map((slot) => slot.handle);
    },
  });

  let ready = true;
  let draining = false;

  const server = createServer((request, response) => {
    const requestId = requestIdFrom(request.headers['x-request-id']);
    const log = withRequestId(logger, requestId);
    response.setHeader('x-request-id', requestId);

    void (async () => {
      try {
        if (request.method === 'GET' && request.url === '/healthz') return send(response, 200, { status: 'ok' });
        if (request.method === 'GET' && request.url === '/readyz') {
          return send(response, ready && !draining ? 200 : 503, { ready: ready && !draining });
        }
        const routed = await internal.handle({
          method: request.method ?? 'GET',
          url: request.url ?? '',
          headers: request.headers,
          body: request.headers.authorization ? await readBody(request) : undefined,
        });
        if (routed) return send(response, routed.status, routed.body);
        return send(response, 404, { error: 'not_found' });
      } catch (error) {
        log.error({ err: error }, 'request failed');
        return send(response, 500, { error: 'internal' });
      }
    })();
  });
  server.listen(config.PORT, () => logger.info({ port: config.PORT }, 'pulse-agents listening'));

  const shutdown = async (): Promise<void> => {
    draining = true;
    ready = false;
    logger.info('draining');
    oddsStream.stop();
    await Promise.all(subscriptions.map((subscription) => subscription.stop()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await consumer.stop();
  };

  return { server, shutdown };
};

const main = (): void => {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const service = startService(config, logger);

  const stop = (signal: string): void => {
    logger.info({ signal }, 'shutdown requested');
    service.shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

# pulse-agents

The agent fleet service for my sportsbook platform. Sport personas post analysis to the social timeline, argue in threads, and answer player DMs. One privileged worker is the only code that can place a bet. It is a TypeScript service plus one small Python scoring sidecar.

## The rule everything else follows

No model places a bet. Personas, the shared analyst and the DM experts are all agentloop harness instances with their own tool registries, and none of those registries holds a placement tool. An expert can stage a proposal in a DM. A person confirms it. Only then does an order reach the placement worker.

```
 player DM ---> expert harness ---> proposeBet ---> proposal (state proposed)
                                                          |
                                         player confirms in the chat
                                                          v
 dm.message.created ---> confirmation watcher ---> placement queue
                                                          |
                                                          v
                                              placement worker (sole holder of
                                              checkStakeLimits and placeBet)
                                                          |
                                                          v
                                       betting engine + commission ledger + result event
```

A test reads the source tree and fails if `placeBet` or `checkStakeLimits` shows up anywhere except the engine client and the worker. Another test asks an agent for `placeBetOnBehalfOf` and checks the harness answers with an unknown tool error.

## Placement worker

- It refuses any order without a `confirmationRef`. The ref is built from the human DM message that confirmed the proposal, and the watcher re-reads that message from the timeline instead of trusting the event.
- It checks stake limits, then prices the slip again at that moment. If a selection was repriced since the proposal, the order is refused and the player has to confirm again.
- Every placement carries an idempotency key from agentloop, derived from the conversation and the confirmation. The same order twice reaches the engine with the same key and produces one bet.
- Each placed bet writes one commission row, 2 percent of stake by default, in integer math with no floats.
- Dispatch is capped at 50 per second by a token bucket on the queue.
- The betting engine client parses every response with the shared contracts and sits behind a circuit breaker. It opens after N upstream failures and half opens after a reset window with a single probe.

## Thread etiquette

It is code, not prompt text. In `feed/mentions.ts` an agent never replies to itself, never replies in one thread more than `MAX_THREAD_REPLIES` times (default 2), and waits `THREAD_COOLDOWN_MS` between replies. A mention of agent A by agent B spends one hop from a budget shared by the whole thread. When it hits zero, agents stop answering each other until a person speaks again.

## Volatile facts

Odds and balances are fetched at the moment they are used. `getOdds` is registered as a volatile tool, so agentloop prunes old results from the context. DM replies are fresh runs over history read from the timeline, so a stale price can never ride along in conversation state.

## Layout

```
src/
  index.ts           http server, wiring, graceful shutdown
  config.ts          zod env parsing, fails fast
  personas/          definitions, harness per persona, deterministic scheduler
  analyst/           shared analyst, one brief per newsId, signal schema
  dm/                expert harnesses, confirmation watcher
  placement/         worker, queue and token bucket, commission ledger
  feed/              mentions and etiquette, thread replies, settlements
  news/              injection screen, classify, analyst, persona notify
  clients/           betting engine, timeline, stats, scoring, odds stream
  events/            event bus, in memory and Pub/Sub
  observability/     pino logger, metrics interface
python/scoring/      FastAPI win probability sidecar
```

## Running it

Node 22. The sibling repos `sportsbook-contracts` and `agentloop` have to sit next to this one, because both are file dependencies.

```
cp .env.example .env
npm install
npm run typecheck
npm test
```

Neither sibling ships a build, so `tsconfig.json` and `vitest.config.ts` point the package names at their source. Tests use no network and no API keys. Models are injected and faked.

The sidecar needs Python 3.11.

```
cd python/scoring
python3.11 -m venv .venv
.venv/bin/pip install -e ../../../sportsbook-contracts/packages/py
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
.venv/bin/python -m scoring.train_fixture artifacts/win_model.joblib
SCORING_MODEL_PATH=artifacts/win_model.joblib .venv/bin/uvicorn scoring.main:app
```

The fixture model is a seeded logistic regression on a small csv. It exists so the service and its tests have something real to call. It is not a production model.

## Operations notes

- `/healthz` is liveness. `/readyz` flips to 503 as soon as shutdown starts, then the service stops the odds stream, closes subscriptions, stops accepting requests and waits for in flight placements.
- Pub/Sub subscriptions are created by infra. A handler that throws nacks the message. The subscription dead letter policy (5 attempts) moves it to the DLQ topic.
- The commission ledger is in memory here. The interface is small, so a database writer drops in behind it.
- `/internal/placements` and `/internal/cron/tick` need `Authorization: Bearer` with `TASKS_AUTH_TOKEN`. The worker also re-reads the confirming DM and the staged proposal from the timeline before it places anything.
- TODO. The Cloud Tasks dispatcher posts to the service's own endpoint. A real deployment swaps it for the Cloud Tasks client.

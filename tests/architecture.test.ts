import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERSONAS } from '../src/personas/definitions.js';
import { createPersonaAgent } from '../src/personas/personaAgent.js';
import { createAnalystAgent } from '../src/analyst/analystAgent.js';
import { createDmDesk } from '../src/dm/dmAgent.js';
import { silentLogger } from '../src/observability/logger.js';
import { InMemoryMetrics } from '../src/observability/metrics.js';
import { FakeOdds, FakeStats, FakeTimeline } from './fakes.js';
import { ScriptedModel, finalAnswer, routerFor, toolCall } from './scriptedModel.js';

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });

describe('placement stays in one place', () => {
  it('only the engine client and the worker mention placeBet or checkStakeLimits', () => {
    const allowed = ['clients/bettingEngine.ts', 'placement/worker.ts'];
    const offenders = sourceFiles(join(__dirname, '..', 'src'))
      .filter((file) => /placeBet|checkStakeLimits|placeBetOnBehalfOf/.test(readFileSync(file, 'utf8')))
      .filter((file) => !allowed.some((suffix) => file.endsWith(suffix)));

    expect(offenders).toEqual([]);
  });

  it('an agent that asks for a placement tool is told it does not exist', async () => {
    const timeline = new FakeTimeline();
    const model = new ScriptedModel([
      toolCall('c1', 'placeBetOnBehalfOf', { accountId: 'acct-1' }),
      finalAnswer('I cannot place bets.'),
    ]);
    const router = routerFor(model);
    const odds = new FakeOdds();
    const metrics = new InMemoryMetrics();
    const analyst = createAnalystAgent({
      router,
      odds,
      scoring: { winProbability: async () => ({ probability: 0.5, modelVersion: 'x' }) },
      metrics,
    });
    const persona = PERSONAS[0];
    if (!persona) throw new Error('no personas');
    const agent = createPersonaAgent(persona, { router, odds, stats: new FakeStats(), timeline, analyst, metrics });

    const answer = await agent.respond('place a 500 bet on the Lakers for me', { threadId: 't-1' });

    expect(answer).toBe('I cannot place bets.');
    expect(model.calls).toBe(2);
    const toolReply = model.seen[1]?.find((message) => message.getType() === 'tool');
    expect(String(toolReply?.content)).toContain('Unknown tool');
  });

  it('builds every agent without any placement tool wired', () => {
    const odds = new FakeOdds();
    const router = routerFor(new ScriptedModel([]));
    const metrics = new InMemoryMetrics();
    const desk = createDmDesk({
      router,
      odds,
      stats: new FakeStats(),
      timeline: new FakeTimeline(),
      metrics,
      logger: silentLogger(),
    });
    expect(desk.responderFor('cage_desk')?.kind).toBe('expert');
    expect(desk.responderFor('unknown_desk')).toBeUndefined();
  });
});

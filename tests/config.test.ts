import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const valid = {
  BETTING_ENGINE_URL: 'http://engine.sportsbook.internal',
  TIMELINE_URL: 'http://timeline.sportsbook.internal',
  STATS_URL: 'http://stats.sportsbook.internal',
  ODDS_STREAM_URL: 'http://odds.sportsbook.internal/stream',
  SCORING_URL: 'http://scoring.sportsbook.internal',
  TASKS_AUTH_TOKEN: 'placeholder-shared-secret',
  GCP_PROJECT_ID: 'oddsmith-dev',
  ANTHROPIC_API_KEY: 'placeholder-anthropic',
  OPENAI_API_KEY: 'placeholder-openai',
};

describe('loadConfig', () => {
  it('applies defaults for the tunables', () => {
    const config = loadConfig(valid);
    expect(config).toMatchObject({
      PORT: 8080,
      MAX_THREAD_REPLIES: 2,
      PLACEMENT_RATE_PER_SECOND: 50,
      COMMISSION_BPS: 200,
    });
  });

  it('fails fast and names every missing variable', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({ ...valid, ANTHROPIC_API_KEY: undefined, BETTING_ENGINE_URL: undefined });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join(' ');
      expect(issues).toContain('ANTHROPIC_API_KEY');
      expect(issues).toContain('BETTING_ENGINE_URL');
    }
  });

  it('rejects values of the wrong shape', () => {
    expect(() => loadConfig({ ...valid, BETTING_ENGINE_URL: 'not a url' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, PORT: '-1' })).toThrow(ConfigError);
  });
});

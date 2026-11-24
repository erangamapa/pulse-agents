import { z } from 'zod';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positiveInt(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  BETTING_ENGINE_URL: z.string().url(),
  TIMELINE_URL: z.string().url(),
  STATS_URL: z.string().url(),
  ODDS_STREAM_URL: z.string().url(),
  SCORING_URL: z.string().url(),
  TASKS_AUTH_TOKEN: z.string().min(16),
  ODDS_MAX_AGE_MS: positiveInt(10_000),
  GCP_PROJECT_ID: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  VLLM_BASE_URL: z.string().url().optional(),
  MAX_THREAD_REPLIES: positiveInt(2),
  THREAD_COOLDOWN_MS: positiveInt(60_000),
  AGENT_HOP_BUDGET: positiveInt(3),
  PLACEMENT_RATE_PER_SECOND: positiveInt(50),
  COMMISSION_BPS: positiveInt(200),
  BREAKER_FAILURE_THRESHOLD: positiveInt(5),
  BREAKER_RESET_MS: positiveInt(15_000),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration. ${issues.join(' ')}`);
  }
}

export const loadConfig = (env: Record<string, string | undefined> = process.env): Config => {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}.`),
    );
  }
  return parsed.data;
};

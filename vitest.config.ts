import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Neither sibling ships a dist until it is built, so tests read their source.
const sibling = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      agentloop: sibling('../agentloop/src/index.ts'),
      'sportsbook-contracts': sibling('../sportsbook-contracts/packages/ts/src/index.ts'),
    },
    // agentloop source lives outside this tree. Without this its langchain imports
    // would resolve to a second copy and instanceof checks across the two would fail.
    dedupe: ['@langchain/core', '@langchain/langgraph', '@langchain/anthropic', '@langchain/openai', 'zod'],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});

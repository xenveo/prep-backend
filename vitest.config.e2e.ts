import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    setupFiles: ['dotenv/config'],
    // e2e never calls real providers (AGENTS.md); these win over .env because dotenv doesn't override.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      LLM_PROVIDER: 'fake',
      STT_PROVIDER: 'fake',
      TTS_PROVIDER: 'fake',
      MAIL_PROVIDER: 'console',
      STORAGE_PROVIDER: 'local',
      LOCAL_STORAGE_DIR: '.data/e2e-storage',
      PROCESS_ROLE: 'all',
    },
    // Specs share one database; run files one at a time.
    fileParallelism: false,
    testTimeout: 20000,
    include: ['**/*.e2e-spec.ts'],
  },
});

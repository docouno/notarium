import RunnableTestsReporter from '@docouno/env/vitest-reporter';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: 'node_modules/.cache/devkit-vitest',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globals: false,
    passWithNoTests: false,
    reporters: ['default', new RunnableTestsReporter()],
    restoreMocks: true,
    clearMocks: true,
  },
});

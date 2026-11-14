import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import RunnableTestsReporter from '@docouno/env/vitest-reporter';

export default defineConfig({
  plugins: [react()],
  cacheDir: 'node_modules/.cache/devkit-vitest',
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: false,
    passWithNoTests: false,
    reporters: ['default', new RunnableTestsReporter()],
    restoreMocks: true,
    clearMocks: true,
  },
});

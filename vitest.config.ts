import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: { include: ['src/**'], exclude: ['src/cli.ts'], thresholds: { statements: 85, branches: 80 } },
  },
});

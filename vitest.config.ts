import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    include: [
      'packages/**/*.{test,spec}.ts',
      'apps/**/*.{test,spec}.ts',
      'tests/**/*.{test,spec}.ts',
    ],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/**', 'dist/**', '**/*.d.ts'],
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['./vitest.node.config.ts', './vitest.client.config.ts'],
  },
});

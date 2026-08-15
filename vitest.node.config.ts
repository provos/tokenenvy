import { sveltekit } from '@sveltejs/kit/vite';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [sveltekit()],
  test: {
    name: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.client.test.ts'],
    testTimeout: 30_000,
  },
});

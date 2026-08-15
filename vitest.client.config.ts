import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [sveltekit(), svelteTesting()],
  test: {
    name: 'client',
    include: ['tests/**/*.client.test.ts'],
    environment: 'happy-dom',
    testTimeout: 30_000,
  },
});

import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ out: 'build' }),
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'connect-src': ['self'],
        'font-src': ['self'],
        'img-src': ['self', 'blob:', 'data:'],
        'style-src': ['self', 'unsafe-inline'],
        'object-src': ['none'],
        'base-uri': ['none'],
        'frame-ancestors': ['none'],
        'form-action': ['self'],
      },
    },
  },
};

export default config;

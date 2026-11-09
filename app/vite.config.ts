import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The plugin serves index.html at /pos and rewrites ./assets/ to the plugin's URL.
export default defineConfig({
  base: './',
  plugins: [preact()],
  server: {
    proxy: { '/wp-json': 'http://localhost:8088' },
  },
  build: {
    outDir: '../plugin/shoptill/app',
    emptyOutDir: true,
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/parity/**/*.test.ts', 'tests/server/**/*.test.ts'],
    // Parity and server tests share one dev shop and read the day's totals.
    fileParallelism: false,
  },
});

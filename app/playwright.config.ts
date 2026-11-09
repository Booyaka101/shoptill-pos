import { defineConfig } from '@playwright/test';

// Runs against the Docker WooCommerce in ../docker-compose.yml. Build the app first (npm run build).
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/setup.ts',
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: process.env.SHOPTILL_URL ?? 'http://localhost:8088',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
});

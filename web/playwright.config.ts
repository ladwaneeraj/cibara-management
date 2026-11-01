import { defineConfig } from '@playwright/test'

// Manual smoke, not a CI gate. Runs against an already-running server
// (backend/tests/demo_server or a real instance). Point it at one with:
//   PLAYWRIGHT_BASE_URL=http://localhost:8080 npm run e2e
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:8080',
    headless: true,
  },
})

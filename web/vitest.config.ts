import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose: importing vitest/config's
// defineConfig alongside the @vitejs/plugin-react plugin triggers a
// dual-vite type incompatibility. Tests don't need fast-refresh, so JSX is
// handled by esbuild's automatic runtime instead of the react plugin.
export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    // Unit tests live in src/; e2e/ is Playwright (run via `npm run e2e`).
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
})

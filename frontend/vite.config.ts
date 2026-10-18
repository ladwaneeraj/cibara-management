import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Two bundles share this config and the design system in ./src:
//   default            → the staff SPA, base /app/, built to dist/
//                        (served by FastAPI under /app when UI_MODE=spa)
//   --mode analytics   → the lean /analytics page (frontend/analytics), base
//                        /analytics/, built to dist/analytics/ (always served by
//                        FastAPI at /analytics, whatever UI_MODE is)
// In dev, `npm run dev` / `npm run dev:analytics` proxy API + legacy paths to uvicorn on :8080.
export default defineConfig(({ mode }) => {
  const analytics = mode === 'analytics'
  return {
    root: analytics ? here('./analytics') : undefined,
    base: analytics ? '/analytics/' : '/app/',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': here('./src') } },
    server: {
      port: analytics ? 5174 : 5173,
      // The analytics root is frontend/analytics; it imports the shared ../src.
      fs: { allow: [here('.')] },
      proxy: {
        '/api': 'http://localhost:8080',
        '/legacy': 'http://localhost:8080',
        '/static': 'http://localhost:8080',
        ...(analytics
          ? {
              '/customer_insights': 'http://localhost:8080',
              '/customer_segment': 'http://localhost:8080',
              '/login': 'http://localhost:8080',
            }
          : {}),
      },
    },
    build: {
      outDir: analytics ? here('./dist/analytics') : 'dist',
      emptyOutDir: true,
      sourcemap: false,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks: analytics
            ? // Lean bundle: three vendor chunks (react / state / charts), no firebase, no router.
              (id: string) => {
                if (!id.includes('node_modules')) return undefined
                if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
                if (/node_modules\/(@tanstack|zustand)\//.test(id)) return 'query'
                if (/node_modules\/(recharts|recharts-scale|victory-vendor|d3-[a-z-]+|internmap|decimal\.js-light|eventemitter3|fast-equals|lodash|react-smooth|react-transition-group|tiny-invariant|clsx)\//.test(id)) return 'charts'
                return undefined
              }
            : ({
                react: ['react', 'react-dom', 'react-router-dom'],
                query: ['@tanstack/react-query', 'zustand'],
                charts: ['recharts'],
                firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore'],
              } as Record<string, string[]>),
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      coverage: { provider: 'v8' as const, include: ['src/**/*.{ts,tsx}', 'analytics/**/*.{ts,tsx}'], exclude: ['src/test/**', 'src/main.tsx', 'analytics/main.tsx'] },
    },
  }
})

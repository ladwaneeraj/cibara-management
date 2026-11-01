import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Build config. Vitest uses vitest.config.ts (kept separate to avoid the
// dual-vite type clash between vite and vitest's bundled vite).
//
// The Bookings island builds to a single external bundle that the classic
// Flask template loads via asset_url('react/bookings.js'). Fixed filenames
// (no content hash) because asset_url appends ?v=mtime for cache-busting,
// matching every other /static asset in this app. scripts/copy-dist.mjs
// copies dist/ into ../static/react after build.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'bookings.js',
        assetFileNames: (info) =>
          info.name && info.name.endsWith('.css') ? 'bookings.css' : 'assets/[name][extname]',
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5180,
    proxy: {
      '/get_bookings': 'http://localhost:8080',
      '/api': 'http://localhost:8080',
      '/static': 'http://localhost:8080',
      '/legacy': 'http://localhost:8080',
    },
  },
})

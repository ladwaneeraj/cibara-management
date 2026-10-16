import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => cleanup())

// jsdom lacks these
if (!window.matchMedia) {
  window.matchMedia = (q: string) => ({
    matches: false, media: q, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList
}
if (!globalThis.crypto?.randomUUID) {
  ;(globalThis as unknown as { crypto: unknown }).crypto = { ...(globalThis.crypto || {}), randomUUID: () => Math.random().toString(16).slice(2) }
}
class RO { observe() {} unobserve() {} disconnect() {} }
const g = globalThis as unknown as { ResizeObserver?: unknown }
g.ResizeObserver = g.ResizeObserver || RO

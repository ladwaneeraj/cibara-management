import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { useAuth, type Role } from '@/lib/auth'

type Handler = (url: URL, init: RequestInit) => unknown | Response | Promise<unknown | Response>

/** fetch mock routed by "METHOD /path" (query string ignored). */
export function mockFetch(routes: Record<string, Handler | unknown>) {
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost')
    const method = (init.method || 'GET').toUpperCase()
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) || {}))
    let body: unknown = undefined
    if (typeof init.body === 'string') body = JSON.parse(init.body)
    calls.push({ method, url: url.pathname + url.search, body, headers })
    const key = `${method} ${url.pathname}`
    const h = routes[key] ?? routes[url.pathname]
    if (h === undefined) return new Response(JSON.stringify({ success: false, message: `no mock for ${key}` }), { status: 404, headers: { 'content-type': 'application/json' } })
    const out = typeof h === 'function' ? await (h as Handler)(url, init) : h
    if (out instanceof Response) return out
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fn)
  return { fn, calls }
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const PERMS: Record<Role, string[]> = {
  admin: ['*'],
  manager: ['app.access', 'room.view', 'room.checkin', 'room.checkout', 'room.update', 'room.transfer', 'register.view',
    'bill.guest.edit', 'settlement.collect', 'expense.view', 'guest_request.handle', 'room.cleaning.complete', 'room.inspection.approve'],
  housekeeping: ['app.access', 'room.cleaning.view', 'room.cleaning.complete', 'guest_request.handle'],
}

export function signIn(role: Role = 'admin') {
  useAuth.setState({
    status: 'authenticated',
    user: { userId: `${role}1`, name: role === 'admin' ? 'Asha Admin' : 'Mo Manager', role, roleLabel: role, authUid: 'uid1' },
    permissions: new Set(PERMS[role]),
    token: 'test-token',
    firebaseToken: null,
  })
}

export function renderWith(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return { qc, ...render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter></QueryClientProvider>) }
}

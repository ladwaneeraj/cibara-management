/**
 * API client for /api/v2 (and the few legacy paths the SPA links to).
 *
 * Behaviour the backend relies on — ported from static/auth.js apiFetch:
 *  - Bearer access token on every call (kept in memory only).
 *  - On 401: one single-flight refresh, then retry once with the SAME
 *    X-Op-Id so the server-side duplicate guard can replay instead of
 *    writing twice. Only a refresh the server DENIES signs the user out; a
 *    refresh that cannot reach the server (503 / network) keeps the session.
 *  - Every write carries a fresh X-Op-Id.
 *  - 409 {duplicate_suspected}: a repeat within 2 s is dropped silently
 *    (double click); otherwise the operator confirms and the request is
 *    resent with X-Force-Duplicate: 1.
 *  - Any body with success:false is an error, whatever the HTTP status
 *    (many legacy routes answer 200 + success:false).
 */

export class ApiError extends Error {
  status: number
  body: unknown
  duplicate: boolean
  constructor(message: string, status: number, body?: unknown, duplicate = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    this.duplicate = duplicate
  }
  get code(): string | undefined {
    return (this.body as { code?: string } | undefined)?.code
  }
}

/** ok: new access token · denied: session is over · unavailable: server or
 *  Firebase unreachable — keep the session and let the caller retry. */
export type RefreshResult = 'ok' | 'denied' | 'unavailable'

type Hooks = {
  getToken: () => string | null
  refresh: () => Promise<RefreshResult>
  onAuthLost: (message: string) => void
  confirmDuplicate: (secondsAgo: number) => Promise<boolean>
}

let hooks: Hooks = {
  getToken: () => null,
  refresh: async () => 'denied',
  onAuthLost: () => {},
  confirmDuplicate: async () => false,
}

export function configureApi(h: Partial<Hooks>) {
  hooks = { ...hooks, ...h }
}

export type Query = Record<string, string | number | boolean | null | undefined>

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Query
  signal?: AbortSignal
  raw?: boolean // return the Response (e.g. PNG)
  opId?: string
  auth?: boolean // default true
}

export function newOpId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `op_${Date.now()}_${Math.random().toString(16).slice(2)}`
  }
}

export function buildUrl(path: string, query?: Query): string {
  if (!query) return path
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    qs.set(k, String(v))
  }
  const s = qs.toString()
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path
}

async function parse(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    try {
      return await res.json()
    } catch {
      return null
    }
  }
  return null
}

function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown; detail?: unknown }
    if (typeof b.message === 'string' && b.message) return b.message
    if (typeof b.detail === 'string' && b.detail) return b.detail
  }
  return fallback
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method || 'GET'
  const isWrite = method !== 'GET'
  const url = buildUrl(path, opts.query)
  let opId = opts.opId || (isWrite ? newOpId() : undefined)
  let force = false

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const token = opts.auth === false ? null : hooks.getToken()
    if (token) headers.Authorization = `Bearer ${token}`
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opId) headers['X-Op-Id'] = opId
    if (force) headers['X-Force-Duplicate'] = '1'
    return fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      credentials: 'same-origin',
    })
  }

  let res = await send()

  if (res.status === 401 && opts.auth !== false) {
    const r = await hooks.refresh()
    if (r === 'unavailable') {
      throw new ApiError('Cannot reach the server right now. Please try again.', 503)
    }
    if (r === 'denied') {
      hooks.onAuthLost('Your session ended. Please sign in again.')
      throw new ApiError('Your session ended. Please sign in again.', 401)
    }
    res = await send() // same X-Op-Id
    if (res.status === 401) {
      hooks.onAuthLost('Your session ended. Please sign in again.')
      throw new ApiError('Your session ended. Please sign in again.', 401)
    }
  }

  if (res.status === 409 && isWrite) {
    const body = (await parse(res.clone())) as { duplicate_suspected?: boolean; seconds_ago?: number } | null
    if (body?.duplicate_suspected) {
      const ago = Number(body.seconds_ago || 0)
      if (ago < 2) throw new ApiError('Duplicate click ignored — this was already recorded.', 409, body, true)
      const again = await hooks.confirmDuplicate(ago)
      if (!again) throw new ApiError('Skipped — not recorded a second time.', 409, body, true)
      force = true
      opId = newOpId()
      res = await send()
    }
  }

  if (opts.raw) {
    if (!res.ok) throw new ApiError(messageOf(await parse(res), `Request failed (${res.status})`), res.status)
    return res as unknown as T
  }

  const body = await parse(res)
  if (!res.ok || (body && typeof body === 'object' && (body as { success?: unknown }).success === false)) {
    const fallback =
      res.status === 429 ? 'Too many requests. Please wait a moment.' :
      res.status === 403 ? 'You do not have permission to do that.' :
      res.status >= 500 ? 'Server error. Please try again.' : `Request failed (${res.status})`
    throw new ApiError(messageOf(body, fallback), res.status, body)
  }
  return body as T
}

export const get = <T>(path: string, query?: Query, signal?: AbortSignal) => api<T>(path, { query, signal })
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} })
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body: body ?? {} })
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' })

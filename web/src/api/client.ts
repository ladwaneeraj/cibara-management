// Typed fetch wrapper over the classic UI's window.apiFetch (static/auth.js),
// which carries the JWT, the single-flight 401 refresh-retry, and the
// X-Op-Id duplicate-submit protocol. This wrapper does NOT add its own retry:
// it makes ONE logical call and lets auth.js govern refresh. It only
// JSON-encodes bodies, stamps X-Op-Id on mutating methods, and maps the
// {success, message} envelope to a value or an ApiError.

export class ApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface ApiInit {
  method?: string
  json?: unknown
  headers?: HeadersInit
  /** Reuse a fixed op id (e.g. when the caller retries) instead of a fresh one. */
  opId?: string
  signal?: AbortSignal
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function newOpId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return 'op-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export async function apiFetch<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)

  let body: BodyInit | undefined
  if (init.json !== undefined) {
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    body = JSON.stringify(init.json)
  }
  if (MUTATING.has(method) && !headers.has('X-Op-Id')) {
    headers.set('X-Op-Id', init.opId ?? newOpId())
  }

  const fetchImpl: typeof fetch =
    typeof window !== 'undefined' && window.apiFetch ? window.apiFetch : fetch

  const res = await fetchImpl(path, { method, headers, body, signal: init.signal })
  const data = (await res.json().catch(() => null)) as
    | ({ success?: boolean; message?: string } & Record<string, unknown>)
    | null

  if (!res.ok) throw new ApiError(data?.message ?? `Request failed (${res.status})`)
  if (data && data.success === false) throw new ApiError(data.message ?? 'Request failed')
  return data as T
}

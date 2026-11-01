import { apiFetch, ApiError } from './client'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

describe('apiFetch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as unknown as { apiFetch?: unknown }).apiFetch
  })

  it('parses a success envelope', async () => {
    window.apiFetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, bookings: [1] }))
    const data = await apiFetch<{ success: boolean; bookings: number[] }>('/get_bookings')
    expect(data.bookings).toEqual([1])
  })

  it('throws ApiError with the server message on success:false', async () => {
    // Fresh Response per call — a Response body can only be read once.
    window.apiFetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ success: false, message: 'nope' })),
    )
    await expect(apiFetch('/x')).rejects.toBeInstanceOf(ApiError)
    await expect(apiFetch('/x')).rejects.toThrow('nope')
  })

  it('throws ApiError on a non-2xx response', async () => {
    window.apiFetch = vi.fn().mockResolvedValue(jsonResponse({ message: 'bad' }, { status: 500 }))
    await expect(apiFetch('/x')).rejects.toThrow('bad')
  })

  it('attaches X-Op-Id and JSON body on a mutating request', async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse({ success: true }))
    window.apiFetch = spy
    await apiFetch('/create_booking', { method: 'POST', json: { a: 1 } })
    const init = spy.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('X-Op-Id')).toBeTruthy()
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(init.body).toBe(JSON.stringify({ a: 1 }))
  })

  it('reuses a caller-supplied opId (for a single refresh-retry)', async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse({ success: true }))
    window.apiFetch = spy
    await apiFetch('/create_booking', { method: 'POST', json: {}, opId: 'fixed-123' })
    const headers = new Headers((spy.mock.calls[0][1] as RequestInit).headers)
    expect(headers.get('X-Op-Id')).toBe('fixed-123')
  })

  it('falls back to window.fetch when window.apiFetch is absent', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ success: true }))
    await apiFetch('/get_bookings')
    expect(fetchSpy).toHaveBeenCalled()
  })
})

import { apiFetch } from './client'

// Guard: the wrapper must delegate the whole request to window.apiFetch in a
// SINGLE call and never add its own retry — the single-flight 401 refresh and
// same-X-Op-Id retry live in static/auth.js. A second call here would mean a
// duplicate submit (Review Focus: 401 retry / duplicate-submit).
function ok(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('apiFetch passthrough', () => {
  afterEach(() => {
    delete (window as unknown as { apiFetch?: unknown }).apiFetch
  })

  it('invokes window.apiFetch exactly once per logical call', async () => {
    const spy = vi.fn(() => ok({ success: true }))
    window.apiFetch = spy
    await apiFetch('/get_bookings')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

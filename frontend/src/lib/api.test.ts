import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, buildUrl, configureApi, type RefreshResult } from './api'
import { json, mockFetch } from '@/test/utils'

describe('api client', () => {
  let token = 't1'
  const refresh = vi.fn(async (): Promise<RefreshResult> => { token = 't2'; return 'ok' })
  const onAuthLost = vi.fn()
  const confirmDuplicate = vi.fn(async () => true)
  beforeEach(() => {
    token = 't1'
    refresh.mockClear(); onAuthLost.mockClear(); confirmDuplicate.mockClear()
    configureApi({ getToken: () => token, refresh, onAuthLost, confirmDuplicate })
  })

  it('builds query strings and skips empty values', () => {
    expect(buildUrl('/x', { a: 1, b: '', c: null, d: 'y z' })).toBe('/x?a=1&d=y+z')
    expect(buildUrl('/x')).toBe('/x')
  })

  it('sends bearer token and X-Op-Id only on writes', async () => {
    const { calls } = mockFetch({ 'GET /a': { success: true }, 'POST /b': { success: true } })
    await api('/a')
    await api('/b', { method: 'POST', body: { x: 1 } })
    expect(calls[0].headers.Authorization).toBe('Bearer t1')
    expect(calls[0].headers['X-Op-Id']).toBeUndefined()
    expect(calls[1].headers['X-Op-Id']).toBeTruthy()
    expect(calls[1].body).toEqual({ x: 1 })
  })

  it('refreshes once on 401 and retries with the same op id', async () => {
    let n = 0
    const { calls } = mockFetch({ 'POST /w': () => (n++ === 0 ? json({ success: false, message: 'expired' }, 401) : json({ success: true, ok: 1 })) })
    const r = await api<{ ok: number }>('/w', { method: 'POST', body: {} })
    expect(r.ok).toBe(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(calls[0].headers['X-Op-Id']).toBe(calls[1].headers['X-Op-Id'])
    expect(calls[1].headers.Authorization).toBe('Bearer t2')
  })

  it('signs out when the server denies the refresh', async () => {
    refresh.mockImplementationOnce(async () => 'denied')
    mockFetch({ 'GET /a': json({ success: false }, 401) })
    await expect(api('/a')).rejects.toMatchObject({ status: 401 })
    expect(onAuthLost).toHaveBeenCalled()
  })

  it('keeps the session when the refresh endpoint is unreachable', async () => {
    refresh.mockImplementationOnce(async () => 'unavailable')
    mockFetch({ 'GET /a': json({ success: false }, 401) })
    await expect(api('/a')).rejects.toMatchObject({ status: 503 })
    expect(onAuthLost).not.toHaveBeenCalled()
  })

  it('treats success:false with HTTP 200 as an error', async () => {
    mockFetch({ 'POST /x': { success: false, message: 'Room 201 is already occupied' } })
    await expect(api('/x', { method: 'POST', body: {} })).rejects.toThrow('Room 201 is already occupied')
  })

  it('maps FastAPI and legacy error bodies', async () => {
    mockFetch({ 'GET /a': json({ success: false, message: 'Forbidden: missing permission' }, 403), 'GET /b': json({ detail: 'nope' }, 400) })
    await expect(api('/a')).rejects.toMatchObject({ status: 403, message: 'Forbidden: missing permission' })
    await expect(api('/b')).rejects.toThrow('nope')
  })

  it('drops a duplicate double-click silently', async () => {
    mockFetch({ 'POST /d': json({ success: false, duplicate_suspected: true, seconds_ago: 0.6 }, 409) })
    const err = (await api('/d', { method: 'POST', body: {} }).catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.duplicate).toBe(true)
    expect(confirmDuplicate).not.toHaveBeenCalled()
  })

  it('asks before re-sending a later duplicate with X-Force-Duplicate', async () => {
    let n = 0
    const { calls } = mockFetch({ 'POST /d': () => (n++ === 0 ? json({ success: false, duplicate_suspected: true, seconds_ago: 5 }, 409) : json({ success: true })) })
    await api('/d', { method: 'POST', body: { a: 1 } })
    expect(confirmDuplicate).toHaveBeenCalledWith(5)
    expect(calls[1].headers['X-Force-Duplicate']).toBe('1')
    expect(calls[1].headers['X-Op-Id']).not.toBe(calls[0].headers['X-Op-Id'])
  })

  it('does not resend when the operator declines', async () => {
    confirmDuplicate.mockImplementationOnce(async () => false)
    const { calls } = mockFetch({ 'POST /d': json({ success: false, duplicate_suspected: true, seconds_ago: 5 }, 409) })
    await expect(api('/d', { method: 'POST', body: {} })).rejects.toMatchObject({ duplicate: true })
    expect(calls).toHaveLength(1)
  })

  it('skips the bearer header for auth=false', async () => {
    const { calls } = mockFetch({ 'POST /login': { success: true } })
    await api('/login', { method: 'POST', body: {}, auth: false })
    expect(calls[0].headers.Authorization).toBeUndefined()
  })
})

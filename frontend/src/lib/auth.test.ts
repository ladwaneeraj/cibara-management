import { beforeEach, describe, expect, it } from 'vitest'
import { json, mockFetch } from '@/test/utils'
import { useAuth } from './auth'

const session = (role = 'manager') => ({ access_token: 'acc', expires_in: 900, permissions: ['room.checkin'], firebase_custom_token: 'fb',
  user: { userId: 'm', name: 'M', role, roleLabel: 'Manager', authUid: 'u' } })

describe('auth store', () => {
  beforeEach(() => useAuth.setState({ status: 'booting', user: null, token: null, permissions: new Set(), firebaseToken: null, notice: null }))

  it('bootstraps from the refresh cookie and asks for a realtime token once', async () => {
    const { calls } = mockFetch({ 'POST /api/v2/auth/refresh': session() })
    await useAuth.getState().bootstrap()
    expect(useAuth.getState().status).toBe('authenticated')
    expect(calls[0].url).toContain('firebase=true')
    expect(useAuth.getState().can('room.checkin')).toBe(true)
    expect(useAuth.getState().can('user.manage')).toBe(false)
    await useAuth.getState().refresh()
    expect(calls[1].url).not.toContain('firebase=true')
  })

  it('concurrent refreshes share one request', async () => {
    const { calls } = mockFetch({ 'POST /api/v2/auth/refresh': session() })
    await Promise.all([useAuth.getState().refresh(), useAuth.getState().refresh(), useAuth.getState().refresh()])
    expect(calls).toHaveLength(1)
  })

  it('falls back to anonymous without a cookie', async () => {
    mockFetch({ 'POST /api/v2/auth/refresh': json({ success: false, message: 'Not signed in' }, 401) })
    await useAuth.getState().bootstrap()
    expect(useAuth.getState().status).toBe('anonymous')
  })

  it('a transient refresh failure is "unavailable", not a denial', async () => {
    mockFetch({ 'POST /api/v2/auth/refresh': json({ success: false, message: 'Sign-in service is unreachable' }, 503) })
    expect(await useAuth.getState().refresh()).toBe('unavailable')
    mockFetch({ 'POST /api/v2/auth/refresh': json({ success: false, message: 'ended' }, 401) })
    expect(await useAuth.getState().refresh()).toBe('denied')
  })

  it('?signout=1 (classic UI sign-out) logs out instead of resuming the session', async () => {
    window.history.replaceState(null, '', '/app/login?signout=1')
    sessionStorage.setItem('cibara_logout_msg', 'Your account has been disabled.')
    const { calls } = mockFetch({ 'POST /api/v2/auth/refresh': session(), 'POST /api/v2/auth/logout': { success: true } })
    await useAuth.getState().bootstrap()
    expect(calls.map((c) => c.url)).toEqual(['/api/v2/auth/logout'])
    expect(useAuth.getState().status).toBe('anonymous')
    expect(useAuth.getState().notice).toBe('Your account has been disabled.')
    expect(window.location.search).toBe('')
  })

  it('logout clears the session and keeps the notice', async () => {
    mockFetch({ 'POST /api/v2/auth/refresh': session(), 'POST /api/v2/auth/logout': { success: true } })
    await useAuth.getState().bootstrap()
    await useAuth.getState().logout('Password changed.')
    const s = useAuth.getState()
    expect(s.status).toBe('anonymous')
    expect(s.token).toBeNull()
    expect(s.notice).toBe('Password changed.')
  })
})

/**
 * Auth state (Zustand). The access token lives only in memory; the refresh
 * token is an HttpOnly cookie the browser sends to /api/v2/auth/refresh.
 * A page reload therefore starts with `bootstrap()` → refresh.
 */
import { create } from 'zustand'
import { ApiError, api, configureApi, type RefreshResult } from './api'

export type Role = 'admin' | 'manager' | 'housekeeping'

export interface User {
  userId: string
  name: string
  role: Role
  roleLabel: string
  authUid: string
}

interface Session {
  access_token: string
  expires_in: number
  user: User
  permissions: string[]
  firebase_custom_token?: string | null
}

type Status = 'booting' | 'authenticated' | 'anonymous'

interface AuthState {
  status: Status
  user: User | null
  permissions: Set<string>
  token: string | null
  firebaseToken: string | null
  notice: string | null
  bootstrap: () => Promise<void>
  login: (userId: string, password: string) => Promise<void>
  logout: (notice?: string) => Promise<void>
  refresh: () => Promise<RefreshResult>
  can: (perm: string) => boolean
  clearNotice: () => void
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined
let inflight: Promise<RefreshResult> | null = null
const listeners = new Set<(s: Status) => void>()

export function onAuthChange(fn: (s: Status) => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const useAuth = create<AuthState>((set, get) => {
  const apply = (s: Session) => {
    set({
      status: 'authenticated',
      user: s.user,
      permissions: new Set(s.permissions),
      token: s.access_token,
      firebaseToken: s.firebase_custom_token ?? get().firebaseToken,
    })
    // refresh a minute before expiry (min 30 s)
    schedule(Math.max(30, s.expires_in - 60) * 1000)
    listeners.forEach((l) => l('authenticated'))
  }

  const schedule = (ms: number) => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(async () => {
      // Server unreachable: keep the session and try again shortly. The
      // access token may expire meanwhile; calls then retry via 401 → refresh.
      if ((await get().refresh()) === 'unavailable') schedule(30_000)
    }, ms)
  }

  const reset = (notice: string | null = null) => {
    clearTimeout(refreshTimer)
    set({ status: 'anonymous', user: null, permissions: new Set(), token: null, firebaseToken: null, notice })
    listeners.forEach((l) => l('anonymous'))
  }

  return {
    status: 'booting',
    user: null,
    permissions: new Set(),
    token: null,
    firebaseToken: null,
    notice: null,

    async bootstrap() {
      // /login (classic UI sign-out, or classic UI with no Firebase user)
      // lands here as /app/login?signout=1: end this browser's session too,
      // instead of silently signing back in from the refresh cookie.
      if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('signout') === '1') {
        let msg: string | null = null
        try {
          msg = sessionStorage.getItem('cibara_logout_msg')
          sessionStorage.removeItem('cibara_logout_msg')
        } catch {
          /* storage blocked */
        }
        window.history.replaceState(window.history.state, '', window.location.pathname)
        await get().logout(msg ?? undefined)
        return
      }
      const r = await get().refresh()
      if (r === 'unavailable') {
        reset('Cannot reach the server. Check the connection and sign in again.')
      } else if (r !== 'ok') {
        reset(get().notice)
      }
    },

    async login(userId, password) {
      const s = await api<Session>('/api/v2/auth/login', {
        method: 'POST', body: { user_id: userId, password }, auth: false,
      })
      apply(s)
    },

    async logout(notice) {
      try {
        await api('/api/v2/auth/logout', { method: 'POST', body: {}, auth: false })
      } catch {
        /* cookie cleared server-side or already gone */
      }
      reset(notice ?? null)
    },

    refresh() {
      if (inflight) return inflight
      const needFirebase = !get().firebaseToken
      inflight = api<Session>('/api/v2/auth/refresh', {
        method: 'POST', body: {}, auth: false, query: needFirebase ? { firebase: true } : undefined,
      })
        .then((s): RefreshResult => {
          apply(s)
          return 'ok'
        })
        .catch((e: unknown): RefreshResult => {
          // 401/403 = the server says this session is over. Anything else
          // (503, 5xx, offline, 429) is transient.
          if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return 'denied'
          return 'unavailable'
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    },

    can(perm) {
      const p = get().permissions
      return p.has('*') || p.has(perm)
    },

    clearNotice: () => set({ notice: null }),
  }
})

// Wire the API client to this store.
configureApi({
  getToken: () => useAuth.getState().token,
  refresh: () => useAuth.getState().refresh(),
  onAuthLost: (msg) => {
    if (useAuth.getState().status === 'authenticated') void useAuth.getState().logout(msg)
  },
})

export function useCan(perm: string): boolean {
  return useAuth((s) => s.permissions.has('*') || s.permissions.has(perm))
}

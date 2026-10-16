/**
 * Live updates through Firestore listeners (same security rules as before).
 *
 * The backend mints a Firebase custom token at login/refresh; signing in with
 * it gives this browser a Firebase session carrying the user's role claim, so
 * firestore.rules authorise the listeners exactly as they did for the old UI
 * (and the legacy screens at /legacy see the same signed-in user).
 *
 * Listeners only patch the TanStack Query cache; every write still goes
 * through the API. If Firebase is unavailable, pages fall back to polling.
 */
import type { QueryClient } from '@tanstack/react-query'
import type { Unsubscribe } from 'firebase/firestore'
import { get } from './api'
import type { Dashboard, Room } from './types'

type Status = 'off' | 'connecting' | 'live' | 'failed'

let status: Status = 'off'
let unsubs: Unsubscribe[] = []
const statusListeners = new Set<(s: Status) => void>()

function setStatus(s: Status) {
  status = s
  statusListeners.forEach((l) => l(s))
}

export function realtimeStatus(): Status {
  return status
}

export function onRealtimeStatus(fn: (s: Status) => void) {
  statusListeners.add(fn)
  return () => statusListeners.delete(fn)
}

let fb: {
  app: import('firebase/app').FirebaseApp
  auth: import('firebase/auth').Auth
  db: import('firebase/firestore').Firestore
} | null = null

async function firebase() {
  if (fb) return fb
  const [{ initializeApp }, authMod, fsMod] = await Promise.all([
    import('firebase/app'), import('firebase/auth'), import('firebase/firestore'),
  ])
  const cfg = await get<{ firebase: Record<string, string> }>('/api/v2/config')
  const app = initializeApp(cfg.firebase)
  const auth = authMod.getAuth(app)
  let db: import('firebase/firestore').Firestore
  try {
    // IndexedDB cache: re-attaching listeners after a reload only pays for
    // documents that changed (the old UI did the same).
    db = fsMod.initializeFirestore(app, {
      localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }),
    })
  } catch {
    db = fsMod.getFirestore(app)
  }
  fb = { app, auth, db }
  return fb
}

/** Mirror of backend compute_stats (dashboard.py) so live patches keep counters right. */
export function recomputeStats(rooms: Room[]) {
  let vacant = 0, occupied = 0, cleaning = 0, renewals = 0, balTotal = 0, balCount = 0
  for (const r of rooms) {
    const sc = r.service_cleaning || {}
    if (r.status === 'vacant') vacant++
    else if (r.status === 'occupied') {
      occupied++
      if (sc.room || sc.bathroom) cleaning++
      const bal = r.balance || 0
      if (bal > 0 && !isMmtPrepaid(r)) { balTotal += bal; balCount++ }
      if (r._renewal?.due) renewals++
    } else if (r.status === 'cleaning') cleaning++
  }
  return { vacant, occupied, cleaning, balances_total: balTotal, balances_count: balCount, renewals_due: renewals, total: rooms.length }
}

export function isMmtPrepaid(r: Pick<Room, 'guest' | 'balance'>) {
  return r.guest?.payment === 'ota' && (r.balance || 0) <= 0
}

/** Same rule as backend renewal_status / static/script.js getRoomRenewalStatus. */
export function renewalStatus(r: Pick<Room, 'status' | 'guest' | 'checkin_time' | 'renewal_count'>, now = new Date()) {
  if (r.status !== 'occupied' || !r.guest) return { day: 0, due: false, next_renewal: null, minutes_left: null }
  if (!r.checkin_time) return { day: 1, due: false, next_renewal: null, minutes_left: null }
  const day = (r.renewal_count || 0) + 1
  // checkin_time is IST wall-clock; build the instant explicitly in +05:30.
  const start = new Date(`${r.checkin_time.replace(' ', 'T')}:00+05:30`)
  const next = new Date(start.getTime() + day * 86400_000)
  const left = Math.floor((next.getTime() - now.getTime()) / 60000)
  const ist = new Date(next.getTime() + 330 * 60000).toISOString()
  return { day, due: left <= 0, next_renewal: `${ist.slice(0, 10)} ${ist.slice(11, 16)}`, minutes_left: left }
}

export async function startRealtime(qc: QueryClient, opts: { customToken: string | null; uid: string; role: string }) {
  stopRealtime()
  setStatus('connecting')
  try {
    const { auth, db } = await firebase()
    const { signInWithCustomToken } = await import('firebase/auth')
    await auth.authStateReady()
    if (!auth.currentUser || auth.currentUser.uid !== opts.uid) {
      if (!opts.customToken) throw new Error('no realtime token')
      await signInWithCustomToken(auth, opts.customToken)
    }
    const { collection, onSnapshot, query, where } = await import('firebase/firestore')

    unsubs.push(onSnapshot(collection(db, 'rooms'), (snap) => {
      if (snap.metadata.hasPendingWrites) return
      qc.setQueryData<Dashboard>(['dashboard'], (old) => {
        if (!old) return old
        const byId = new Map(old.rooms.map((r) => [r.id, r]))
        for (const ch of snap.docChanges()) {
          const id = ch.doc.id
          if (ch.type === 'removed') {
            byId.delete(id)
            continue
          }
          const prev = byId.get(id)
          const data = ch.doc.data() as Omit<Room, 'id'>
          const next = { ...(prev || {}), ...data, id, category: prev?.category || 'other' } as Room
          next._renewal = renewalStatus(next)
          next._mmt_prepaid = isMmtPrepaid(next)
          byId.set(id, next)
        }
        const rooms = old.rooms.map((r) => byId.get(r.id)!).filter(Boolean)
        for (const [id, r] of byId) if (!old.rooms.some((x) => x.id === id)) rooms.push(r)
        return { ...old, rooms, stats: recomputeStats(rooms) }
      })
    }, () => setStatus('failed')))

    const reqQuery = opts.role === 'housekeeping'
      ? query(collection(db, 'guestRequests'), where('active', '==', true), where('team', '==', 'housekeeping'))
      : query(collection(db, 'guestRequests'), where('active', '==', true))
    unsubs.push(onSnapshot(reqQuery, () => {
      void qc.invalidateQueries({ queryKey: ['guest-requests'] })
    }, () => { /* rules may refuse; polling covers it */ }))

    setStatus('live')
  } catch (e) {
    console.warn('[realtime] unavailable, falling back to polling', e)
    setStatus('failed')
  }
}

export function stopRealtime() {
  unsubs.forEach((u) => u())
  unsubs = []
  setStatus('off')
}

/** True when this browser may hold a persisted Firebase session (the old UI
 *  or an earlier SPA session signed in). Avoids loading the Firebase SDK on
 *  sign-out when there is certainly nothing to sign out of. */
async function mayHaveFirebaseSession(): Promise<boolean> {
  try {
    const list = await indexedDB.databases?.()
    if (!list) return true // API unsupported: cannot tell, be safe
    return list.some((d) => d.name === 'firebaseLocalStorageDb')
  } catch {
    return false // no IndexedDB at all → no persisted session
  }
}

/** Ends the Firebase session too, so the classic screens at /legacy (which
 *  share it) are signed out together with the SPA. */
export async function signOutRealtime() {
  stopRealtime()
  if (!fb && !(await mayHaveFirebaseSession())) return
  const f = fb ?? (await firebase().catch(() => null))
  if (!f) return
  const { signOut } = await import('firebase/auth')
  await signOut(f.auth).catch(() => {})
}

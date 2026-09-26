/**
 * Everything the guest's phone does against Firestore, in one place, so it
 * is easy to see that it is not much: prove the room + mobile, read its own
 * session and room, read the portal settings, raise a request, watch its
 * own requests, rate the stay, and leave.
 *
 * None of the checks that matter are here. They are in ../firestore.rules
 * ("Guest portal" section), which re-verify the phone's session on every
 * read and write. A phone that edits this code, or the URL, can send
 * anything it likes and gets the same refusals. Field names mirror
 * services/guest_portal.py and the rules. Change one, change all three.
 */
import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  getAuth, onAuthStateChanged, signInAnonymously, signOut, type Auth, type User,
} from 'firebase/auth'
import {
  collection, doc, getDoc, getFirestore, onSnapshot, query, setDoc, updateDoc, where,
  writeBatch, type Firestore, type Unsubscribe,
} from 'firebase/firestore'

/* ------------------------------- Types --------------------------------- */

export type Team = 'desk' | 'housekeeping'
export type Kind =
  | 'room_service' | 'housekeeping' | 'extra_items' | 'laundry' | 'maintenance'
  | 'wake_up' | 'late_checkout' | 'taxi' | 'do_not_disturb' | 'complaint'
export type Status = 'open' | 'acknowledged' | 'done' | 'cancelled'

export interface KindMeta {
  label: string
  blurb: string
  team: Team
  chips: string[]
  needsNote?: boolean
}

/** Order here is the order of tiles. Mirrors services/guest_portal.py. */
export const KINDS: Record<Kind, KindMeta> = {
  room_service:   { label: 'Room service',     blurb: 'Water, tea, food',        team: 'desk',
                    chips: ['Drinking water', 'Tea', 'Coffee', 'Breakfast', 'Snacks'] },
  housekeeping:   { label: 'Clean my room',    blurb: 'Tidy up, fresh linen',    team: 'housekeeping',
                    chips: ['Fresh towels', 'Bed sheets', 'Dustbin', 'Toiletries', 'Bathroom'] },
  extra_items:    { label: 'Extra items',      blurb: 'Blanket, pillow, iron',   team: 'housekeeping',
                    chips: ['Blanket', 'Pillow', 'Charger', 'Iron', 'Hangers'] },
  laundry:        { label: 'Laundry pickup',   blurb: 'We collect from the room', team: 'housekeeping',
                    chips: ['Wash & fold', 'Iron only', 'Urgent'] },
  maintenance:    { label: 'Something broken', blurb: 'AC, geyser, TV, light',   team: 'desk',
                    chips: ['AC', 'Geyser / hot water', 'TV', 'Light', 'Tap / plumbing', 'Wi-Fi'] },
  wake_up:        { label: 'Wake-up call',     blurb: 'Pick a time',             team: 'desk',
                    chips: ['5:00 AM', '5:30 AM', '6:00 AM', '6:30 AM', '7:00 AM', '8:00 AM'], needsNote: true },
  late_checkout:  { label: 'Late checkout',    blurb: 'Ask for extra time',      team: 'desk',
                    chips: ['By 1 PM', 'By 2 PM', 'By 4 PM'], needsNote: true },
  taxi:           { label: 'Taxi / cab',       blurb: 'Airport, station, town',  team: 'desk',
                    chips: ['Airport', 'Railway station', 'Bus stand', 'Now', 'Tomorrow morning'], needsNote: true },
  do_not_disturb: { label: 'Do not disturb',   blurb: 'Skip housekeeping today', team: 'housekeeping',
                    chips: ['Until noon', 'Until evening', 'All day'] },
  complaint:      { label: 'Talk to manager',  blurb: 'Something not right',     team: 'desk',
                    chips: [], needsNote: true },
}

export interface Settings {
  enabled: boolean
  hotelName: string
  receptionPhone: string
  whatsapp: string
  wifiName: string
  wifiPassword: string
  houseRules: string
  nearbyInfo: string
  checkoutTime: string
  sessionHours: number
  kinds: Partial<Record<Kind, boolean>>
}

export interface Session {
  uid: string
  room: string
  mobileKey: string
  status: 'active' | 'closed'
  closedReason?: string
  createdAtMs: number
  lastActivityAtMs: number
  expiresAtMs: number
  requestCount: number
  lastRequestAtMs: number
}

/** The slice of the ERP's room document the page reads. */
export interface Room {
  status: string
  active_bill_id: string | null
  checkin_time?: string
  guest?: { name?: string; mobile?: string | number; guests?: number }
}

export interface GuestRequest {
  id: string
  room: string
  stayId: string
  guestName: string
  kind: Kind
  team: Team
  note: string
  status: Status
  active: boolean
  createdAt: string
  createdAtMs: number
  acknowledgedAtMs?: number
  doneAtMs?: number
  cancelledAtMs?: number
}

export type GuestErrorCode = 'refused' | 'offline' | 'setup' | 'unknown'

export class GuestError extends Error {
  readonly code: GuestErrorCode
  constructor(message: string, code: GuestErrorCode) {
    super(message)
    this.code = code
  }
}

/** Every refusal reads the same on purpose: nothing to learn from it. */
export const LOGIN_REFUSED =
  "We couldn't match that room and mobile number. Please check with reception."
export const MIN_GAP_MS = 15_000 // mirrors the rules' one request per 15 s

/* ------------------------------ Helpers -------------------------------- */

export function mobileKey(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : ''
}

function isDenied(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code ?? ''
  return code === 'permission-denied' || code === 'not-found'
}
function isOffline(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'unavailable'
}
export function toGuestError(e: unknown, refusedMessage = LOGIN_REFUSED): GuestError {
  if (e instanceof GuestError) return e
  if (isOffline(e)) return new GuestError('No connection. Check your internet and try again.', 'offline')
  if (isDenied(e)) return new GuestError(refusedMessage, 'refused')
  return new GuestError('Something went wrong. Please try again or call reception.', 'unknown')
}

/* ------------------------------ Client --------------------------------- */

let app: FirebaseApp | null = null
let auth: Auth | null = null
let db: Firestore | null = null

function fs(): Firestore {
  if (!db) throw new GuestError('Not connected yet.', 'unknown')
  return db
}

/**
 * Firebase Hosting serves the project's own web config at this reserved
 * URL, so the same build works on the dev and prod projects untouched.
 */
export async function connect(): Promise<void> {
  if (app) return
  const res = await fetch('/__/firebase/init.json')
  if (!res.ok) throw new GuestError('This page must be opened from the hotel QR link.', 'setup')
  const cfg = (await res.json()) as Record<string, string>
  app = initializeApp(cfg)
  auth = getAuth(app)
  db = getFirestore(app)
}

/** Resolves with the anonymous user, signing one in if needed. */
export function ensureUser(): Promise<User> {
  return new Promise((resolve, reject) => {
    if (!auth) return reject(new GuestError('Not connected yet.', 'unknown'))
    const stop = onAuthStateChanged(auth, (user) => {
      if (user) { stop(); resolve(user); return }
      signInAnonymously(auth!).catch((e: { code?: string }) => {
        stop()
        const code = e?.code ?? ''
        if (code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation') {
          reject(new GuestError('The portal is not switched on yet. Please tell reception.', 'setup'))
        } else if (code === 'auth/network-request-failed') {
          reject(new GuestError('No connection. Check your internet and try again.', 'offline'))
        } else {
          reject(new GuestError('Could not start. Please tell reception.', 'unknown'))
        }
      })
    })
  })
}

export async function leave(): Promise<void> {
  if (auth) await signOut(auth).catch(() => {})
}

/* ------------------------------ Reads ---------------------------------- */

export async function readSession(uid: string): Promise<Session | null> {
  const snap = await getDoc(doc(fs(), 'guestSessions', uid))
  return snap.exists() ? (snap.data() as Session) : null
}

/** Only succeeds while the rules consider this phone a proven guest. */
export async function readSettings(): Promise<Settings> {
  const snap = await getDoc(doc(fs(), 'settings', 'guest_portal'))
  return { kinds: {}, sessionHours: 24, ...(snap.data() ?? {}) } as Settings
}

export function watchSession(uid: string, onData: (s: Session | null) => void, onDenied: () => void): Unsubscribe {
  return onSnapshot(doc(fs(), 'guestSessions', uid),
    (snap) => onData(snap.exists() ? (snap.data() as Session) : null),
    (e) => { if (isDenied(e)) onDenied() })
}

export function watchRoom(room: string, onData: (r: Room | null) => void, onDenied: () => void): Unsubscribe {
  return onSnapshot(doc(fs(), 'rooms', room),
    (snap) => onData(snap.exists() ? (snap.data() as Room) : null),
    (e) => { if (isDenied(e)) onDenied() })
}

export function watchRequests(stayId: string, onData: (rows: GuestRequest[]) => void, onDenied: () => void): Unsubscribe {
  return onSnapshot(query(collection(fs(), 'guestRequests'), where('stayId', '==', stayId)),
    (snap) => onData(
      snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<GuestRequest, 'id'>) }))
        .sort((a, b) => b.createdAtMs - a.createdAtMs),
    ),
    (e) => { if (isDenied(e)) onDenied() })
}

export async function readFeedback(stayId: string): Promise<boolean> {
  // A guest may not read feedback (rules), so "exists" is inferred from a
  // refused create later; this only checks nothing locally.
  return Boolean(localStorage.getItem('rated:' + stayId))
}

/* ------------------------------ Writes --------------------------------- */

async function bumpAttempts(uid: string): Promise<void> {
  const ref = doc(fs(), 'guestLoginAttempts', uid)
  const snap = await getDoc(ref)
  if (!snap.exists()) await setDoc(ref, { count: 1, updatedAtMs: Date.now() })
  else await updateDoc(ref, { count: ((snap.data() as { count?: number }).count ?? 0) + 1, updatedAtMs: Date.now() })
}

export async function login(uid: string, room: string, mobile: string): Promise<Session> {
  const key = mobileKey(mobile)
  if (!room.trim() || !key) throw new GuestError('Enter your room number and a 10-digit mobile number.', 'refused')
  try {
    await bumpAttempts(uid)
    const now = Date.now()
    await setDoc(doc(fs(), 'guestSessions', uid), {
      uid, room: room.trim(), mobileKey: key, status: 'active',
      createdAtMs: now, lastActivityAtMs: now, expiresAtMs: now + 24 * 3600_000,
      requestCount: 0, lastRequestAtMs: 0,
    })
    return (await readSession(uid))!
  } catch (e) {
    throw toGuestError(e)
  }
}

/** Sliding expiry, bounded by the rules; failures are silent. */
export function touch(uid: string, sessionHours: number): void {
  updateDoc(doc(fs(), 'guestSessions', uid), {
    lastActivityAtMs: Date.now(),
    expiresAtMs: Date.now() + (sessionHours || 24) * 3600_000,
  }).catch(() => {})
}

export async function sendRequest(
  uid: string, session: Session, room: Room, sessionHours: number, kind: Kind, note: string,
): Promise<void> {
  const fresh = (await readSession(uid)) ?? session
  const now = Date.now()
  const id = `${fresh.room}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const batch = writeBatch(fs())
  batch.update(doc(fs(), 'guestSessions', uid), {
    lastActivityAtMs: now,
    expiresAtMs: now + (sessionHours || 24) * 3600_000,
    requestCount: (fresh.requestCount ?? 0) + 1,
    lastRequestAtMs: now,
  })
  batch.set(doc(fs(), 'guestRequests', id), {
    uid, room: fresh.room, stayId: room.active_bill_id, guestName: room.guest?.name ?? '',
    kind, team: KINDS[kind].team, note: note.slice(0, 300),
    status: 'open', active: true, createdAt: new Date(now).toISOString(), createdAtMs: now,
  })
  try {
    await batch.commit()
  } catch (e) {
    throw toGuestError(e, 'That could not be sent. Your stay may have ended or the portal is off. Please call reception.')
  }
}

export async function cancelRequest(id: string): Promise<void> {
  try {
    await updateDoc(doc(fs(), 'guestRequests', id), { status: 'cancelled', active: false, cancelledAtMs: Date.now() })
  } catch (e) {
    throw toGuestError(e, 'Too late to cancel: staff already picked it up.')
  }
}

export async function rateStay(uid: string, session: Session, room: Room, rating: number, comment: string): Promise<void> {
  const stayId = room.active_bill_id!
  const now = Date.now()
  try {
    await setDoc(doc(fs(), 'guestFeedback', stayId), {
      uid, room: session.room, stayId, guestName: room.guest?.name ?? '',
      rating, comment: comment.slice(0, 500), createdAt: new Date(now).toISOString(), createdAtMs: now,
    })
    localStorage.setItem('rated:' + stayId, '1')
  } catch (e) {
    throw toGuestError(e, 'You have already rated this stay. Thank you!')
  }
}

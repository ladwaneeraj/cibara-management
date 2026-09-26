/**
 * Guest-portal security rules, played against the real rules in the
 * Firestore emulator by a phone that is signed in anonymously and knows a
 * room number: which is all a phone ever knows.
 *
 * Run from the repo root:   npm --prefix tests/rules test
 * (needs Java for the emulator; `npm --prefix tests/rules install` once)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, describe, it } from 'node:test'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'

const here = dirname(fileURLToPath(import.meta.url))
const RULES = readFileSync(join(here, '..', '..', 'firestore.rules'), 'utf8')

const ROOM = '204'         // occupied, stay S1, mobile "+91 98765 43210"
const ROOM_NUM = '206'     // occupied, stay S2, mobile stored as a NUMBER
const ROOM_VACANT = '205'
const S0 = 'stay-old-204'  // the previous guest in 204, already checked out
const S1 = 'stay-one'
const S2 = 'stay-two'
const KEY1 = '9876543210'
const KEY2 = '9111111111'

const PHONE = 'phone-a'
const PHONE_B = 'phone-b'
const PHONE_IN = 'phone-in'   // already proven for room 204 / S1

let env

const anon = (uid) =>
  env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore()
const staff = (role, userId = role + '-1') =>
  env.authenticatedContext(userId, { role, userId, firebase: { sign_in_provider: 'password' } }).firestore()
const nobody = () => env.unauthenticatedContext().firestore()

const now = () => Date.now()
const inAnHour = () => now() + 3600_000

function sessionDoc(room, key, extra = {}) {
  return {
    uid: PHONE,
    room,
    mobileKey: key,
    status: 'active',
    createdAtMs: now(),
    lastActivityAtMs: now(),
    expiresAtMs: inAnHour(),
    requestCount: 0,
    lastRequestAtMs: 0,
    ...extra,
  }
}

function requestDoc(uid, room, stayId, kind, extra = {}) {
  const t = now()
  return {
    uid,
    room,
    stayId,
    guestName: room === ROOM_NUM ? 'Vikram' : 'Asha Rao',
    kind,
    team: ['housekeeping', 'extra_items', 'laundry', 'do_not_disturb'].includes(kind) ? 'housekeeping' : 'desk',
    note: '',
    status: 'open',
    active: true,
    createdAt: new Date(t).toISOString(),
    createdAtMs: t,
    ...extra,
  }
}

/** The batch a well-behaved phone sends: bump the session, add the request. */
async function sendRequest(db, uid, room, stayId, kind, session, opts = {}) {
  const req = requestDoc(uid, room, stayId, kind, opts.request || {})
  const batch = writeBatch(db)
  if (!opts.skipTouch) {
    batch.update(doc(db, 'guestSessions', uid), {
      lastActivityAtMs: req.createdAtMs,
      expiresAtMs: inAnHour(),
      requestCount: session.requestCount + 1,
      lastRequestAtMs: req.createdAtMs,
    })
  }
  batch.set(doc(db, 'guestRequests', opts.id || `req-${Math.random().toString(16).slice(2)}`), req)
  return batch.commit()
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'cibara-rules-test',
    firestore: { rules: RULES },
  })
})

after(async () => {
  await env.cleanup()
})

beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'settings', 'guest_portal'), {
      enabled: true,
      hotelName: 'Cibara Comforts',
      receptionPhone: '+91 80000 00000',
      wifiName: 'Cibara',
      wifiPassword: 'welcome123',
      sessionHours: 24,
      kinds: { room_service: true, complaint: false },
    })
    await setDoc(doc(db, 'rooms', ROOM), {
      status: 'occupied',
      active_bill_id: S1,
      checkin_time: '2026-09-26 14:00',
      guest: { name: 'Asha Rao', mobile: '+91 98765 43210' },
    })
    await setDoc(doc(db, 'rooms', ROOM_NUM), {
      status: 'occupied',
      active_bill_id: S2,
      checkin_time: '2026-09-26 15:30',
      guest: { name: 'Vikram', mobile: 9111111111 },
    })
    await setDoc(doc(db, 'rooms', ROOM_VACANT), { status: 'vacant', active_bill_id: null, guest: null })
    // A phone that already proved room 204.
    await setDoc(doc(db, 'guestLoginAttempts', PHONE_IN), { count: 1, updatedAtMs: now() })
    await setDoc(doc(db, 'guestSessions', PHONE_IN), { ...sessionDoc(ROOM, KEY1), uid: PHONE_IN })
    // The previous guest's request in the same room.
    await setDoc(doc(db, 'guestRequests', 'old-req'), requestDoc('phone-old', ROOM, S0, 'room_service', { status: 'done', active: false }))
    // Something the old phone left open (checked out, never cancelled).
    await setDoc(doc(db, 'guestRequests', 'in-req'), requestDoc(PHONE_IN, ROOM, S1, 'housekeeping'))
    await setDoc(doc(db, 'bills', 'b1'), { total: 1200 })
    await setDoc(doc(db, 'daily_counters', '2026-09-26'), { count: 3 })
  })
})

async function bumpAttempts(db, uid) {
  const ref = doc(db, 'guestLoginAttempts', uid)
  const snap = await getDoc(ref)
  if (!snap.exists()) return setDoc(ref, { count: 1, updatedAtMs: now() })
  return updateDoc(ref, { count: snap.data().count + 1, updatedAtMs: now() })
}

describe('login: room number + the mobile given at check-in', () => {
  it('right room and right number opens a session', async () => {
    const db = anon(PHONE)
    await assertSucceeds(bumpAttempts(db, PHONE))
    await assertSucceeds(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM, KEY1)))
  })

  it('works whatever format staff typed the number in, including a bare number', async () => {
    const db = anon(PHONE)
    await bumpAttempts(db, PHONE)
    await assertSucceeds(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM_NUM, KEY2)))
  })

  it('wrong number is refused', async () => {
    const db = anon(PHONE)
    await bumpAttempts(db, PHONE)
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM, '9876543211')))
  })

  it('a partial or padded key is refused', async () => {
    const db = anon(PHONE)
    await bumpAttempts(db, PHONE)
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM, '43210')))
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM, '919876543210')))
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM, '.*')))
  })

  it('a vacant room is refused, with the same denial as a wrong number', async () => {
    const db = anon(PHONE)
    await bumpAttempts(db, PHONE)
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM_VACANT, KEY1)))
  })

  it('a room that does not exist is refused the same way', async () => {
    const db = anon(PHONE)
    await bumpAttempts(db, PHONE)
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc('999', KEY1)))
  })

  it('the phone cannot smuggle extra fields, counters or a long expiry', async () => {
    const db = anon(PHONE)
    await bumpAttempts(db, PHONE)
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM, KEY1, { stayId: S0 })))
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM, KEY1, { requestCount: 5 })))
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM, KEY1, { isAdmin: true })))
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM, KEY1, { expiresAtMs: now() + 3 * 24 * 3600_000 })))
  })

  it('a session can only be written under the phone\'s own uid', async () => {
    const db = anon(PHONE)
    await bumpAttempts(db, PHONE)
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE_B), { ...sessionDoc(ROOM, KEY1), uid: PHONE_B }))
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), { ...sessionDoc(ROOM, KEY1), uid: PHONE_B }))
  })

  it('no attempt counter, no login; six wrong tries lock the phone out', async () => {
    const db = anon(PHONE)
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM, KEY1)))
    for (let i = 0; i < 6; i++) await assertSucceeds(bumpAttempts(db, PHONE))
    await assertFails(bumpAttempts(db, PHONE))
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM, KEY1)))
    // The counter cannot be reset or jumped by the phone.
    await assertFails(setDoc(doc(db, 'guestLoginAttempts', PHONE), { count: 1, updatedAtMs: now() }))
  })

  it('portal switched off refuses every login', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), 'settings', 'guest_portal'), { enabled: false }))
    const db = anon(PHONE)
    await bumpAttempts(db, PHONE)
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE), sessionDoc(ROOM, KEY1)))
  })

  it('a staff login and a signed-out browser cannot create guest sessions', async () => {
    await assertFails(setDoc(doc(staff('manager'), 'guestSessions', 'manager-1'), { ...sessionDoc(ROOM, KEY1), uid: 'manager-1' }))
    await assertFails(setDoc(doc(nobody(), 'guestSessions', PHONE), sessionDoc(ROOM, KEY1)))
  })
})

describe('what a proven phone can and cannot read', () => {
  it('reads its own session, its own room and the portal settings, nothing else', async () => {
    const db = anon(PHONE_IN)
    await assertSucceeds(getDoc(doc(db, 'guestSessions', PHONE_IN)))
    await assertSucceeds(getDoc(doc(db, 'settings', 'guest_portal')))
    await assertSucceeds(getDoc(doc(db, 'rooms', ROOM)))
    await assertFails(getDoc(doc(db, 'guestSessions', PHONE)))
    await assertFails(getDoc(doc(db, 'rooms', ROOM_NUM)))
    await assertFails(getDocs(collection(db, 'rooms')))
    await assertFails(getDoc(doc(db, 'bills', 'b1')))
    await assertFails(getDoc(doc(db, 'settings', 'ui_config')))
  })

  it('a phone that only scanned the code cannot read the Wi-Fi password', async () => {
    await assertFails(getDoc(doc(anon(PHONE), 'settings', 'guest_portal')))
    await assertFails(getDoc(doc(nobody(), 'settings', 'guest_portal')))
    await assertFails(getDoc(doc(anon(PHONE), 'rooms', ROOM)))
  })

  it('sees only its own stay\'s requests, never the previous guest\'s in the same room', async () => {
    const db = anon(PHONE_IN)
    await assertSucceeds(getDocs(query(collection(db, 'guestRequests'), where('stayId', '==', S1))))
    await assertFails(getDocs(query(collection(db, 'guestRequests'), where('stayId', '==', S0))))
    await assertFails(getDocs(query(collection(db, 'guestRequests'), where('room', '==', ROOM))))
    await assertFails(getDocs(collection(db, 'guestRequests')))
    await assertFails(getDoc(doc(db, 'guestRequests', 'old-req')))
  })
})

describe('raising a request', () => {
  it('a well-formed request with the session bump lands', async () => {
    const db = anon(PHONE_IN)
    const s = (await getDoc(doc(db, 'guestSessions', PHONE_IN))).data()
    await assertSucceeds(sendRequest(db, PHONE_IN, ROOM, S1, 'room_service', s))
  })

  it('without the session bump it is refused (rate limit cannot be skipped)', async () => {
    const db = anon(PHONE_IN)
    const s = (await getDoc(doc(db, 'guestSessions', PHONE_IN))).data()
    await assertFails(sendRequest(db, PHONE_IN, ROOM, S1, 'room_service', s, { skipTouch: true }))
  })

  it('a second request inside 15 seconds is refused', async () => {
    const db = anon(PHONE_IN)
    let s = (await getDoc(doc(db, 'guestSessions', PHONE_IN))).data()
    await assertSucceeds(sendRequest(db, PHONE_IN, ROOM, S1, 'room_service', s))
    s = (await getDoc(doc(db, 'guestSessions', PHONE_IN))).data()
    await assertFails(sendRequest(db, PHONE_IN, ROOM, S1, 'wake_up', s))
  })

  it('cannot be filed against another room, another stay, or another uid', async () => {
    const db = anon(PHONE_IN)
    const s = (await getDoc(doc(db, 'guestSessions', PHONE_IN))).data()
    await assertFails(sendRequest(db, PHONE_IN, ROOM_NUM, S1, 'room_service', s))
    await assertFails(sendRequest(db, PHONE_IN, ROOM, S2, 'room_service', s))
    await assertFails(sendRequest(db, PHONE_IN, ROOM, S1, 'room_service', s, { request: { uid: PHONE } }))
    await assertFails(sendRequest(db, PHONE_IN, ROOM, S1, 'room_service', s, { request: { guestName: 'Not Asha' } }))
  })

  it('kind must be known and switched on; team must match the kind; note is bounded', async () => {
    const db = anon(PHONE_IN)
    const s = (await getDoc(doc(db, 'guestSessions', PHONE_IN))).data()
    await assertFails(sendRequest(db, PHONE_IN, ROOM, S1, 'complaint', s))        // switched off in settings
    await assertFails(sendRequest(db, PHONE_IN, ROOM, S1, 'champagne', s))        // unknown
    await assertFails(sendRequest(db, PHONE_IN, ROOM, S1, 'housekeeping', s, { request: { team: 'desk' } }))
    await assertFails(sendRequest(db, PHONE_IN, ROOM, S1, 'room_service', s, { request: { note: 'x'.repeat(301) } }))
    await assertFails(sendRequest(db, PHONE_IN, ROOM, S1, 'room_service', s, { request: { status: 'done' } }))
    await assertFails(sendRequest(db, PHONE_IN, ROOM, S1, 'room_service', s, { request: { acknowledgedBy: 'me' } }))
  })

  it('a guest can withdraw its own open request and nothing more', async () => {
    const db = anon(PHONE_IN)
    await assertSucceeds(updateDoc(doc(db, 'guestRequests', 'in-req'), { status: 'cancelled', active: false, cancelledAtMs: now() }))
    // Already cancelled: no second edit.
    await assertFails(updateDoc(doc(db, 'guestRequests', 'in-req'), { status: 'open', active: true, cancelledAtMs: now() }))
    await assertFails(updateDoc(doc(db, 'guestRequests', 'old-req'), { status: 'cancelled', active: false, cancelledAtMs: now() }))
  })

  it('a guest cannot mark its request done or touch staff fields', async () => {
    const db = anon(PHONE_IN)
    await assertFails(updateDoc(doc(db, 'guestRequests', 'in-req'), { status: 'done', active: false }))
    await assertFails(updateDoc(doc(db, 'guestRequests', 'in-req'), { note: 'edited' }))
    await assertFails(updateDoc(doc(db, 'guestRequests', 'in-req'), { status: 'cancelled', active: false, cancelledAtMs: now(), doneBy: 'me' }))
  })
})

describe('rating the stay', () => {
  const fb = (extra = {}) => ({
    uid: PHONE_IN, room: ROOM, stayId: S1, guestName: 'Asha Rao', rating: 5, comment: 'Lovely',
    createdAt: new Date().toISOString(), createdAtMs: now(), ...extra,
  })
  it('once per stay, by the proven phone, under the stay id', async () => {
    const db = anon(PHONE_IN)
    await assertSucceeds(setDoc(doc(db, 'guestFeedback', S1), fb()))
    await assertFails(setDoc(doc(db, 'guestFeedback', S1), fb({ rating: 1 })))
    await assertFails(setDoc(doc(db, 'guestFeedback', S0), fb({ stayId: S0 })))
    await assertFails(setDoc(doc(db, 'guestFeedback', S2), fb({ stayId: S2, room: ROOM_NUM })))
    await assertFails(setDoc(doc(anon(PHONE), 'guestFeedback', S1), fb({ uid: PHONE })))
  })
  it('rating is 1 to 5, comment bounded, and staff read it', async () => {
    const db = anon(PHONE_IN)
    await assertFails(setDoc(doc(db, 'guestFeedback', S1), fb({ rating: 6 })))
    await assertFails(setDoc(doc(db, 'guestFeedback', S1), fb({ rating: 4.5 })))
    await assertFails(setDoc(doc(db, 'guestFeedback', S1), fb({ comment: 'x'.repeat(501) })))
    await assertSucceeds(setDoc(doc(db, 'guestFeedback', S1), fb({ rating: 3, comment: '' })))
    await assertSucceeds(getDoc(doc(staff('manager'), 'guestFeedback', S1)))
    await assertFails(getDoc(doc(staff('housekeeping'), 'guestFeedback', S1)))
    await assertFails(getDoc(doc(db, 'guestFeedback', S1)))
  })
})

describe('checkout ends the phone', () => {
  it('room no longer occupied: every guest read and write is refused', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), 'rooms', ROOM), { status: 'cleaning', active_bill_id: null, guest: null }))
    const db = anon(PHONE_IN)
    await assertFails(getDoc(doc(db, 'settings', 'guest_portal')))
    await assertFails(getDocs(query(collection(db, 'guestRequests'), where('stayId', '==', S1))))
    await assertFails(sendRequest(db, PHONE_IN, ROOM, S1, 'room_service', { requestCount: 0 }))
    await assertFails(updateDoc(doc(db, 'guestSessions', PHONE_IN), { lastActivityAtMs: now(), expiresAtMs: inAnHour() }))
  })

  it('a new guest in the same room is a new stay and a new number: the old phone is out', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), 'rooms', ROOM), { active_bill_id: 'stay-three', guest: { name: 'New Guest', mobile: '9000000000' } }))
    const db = anon(PHONE_IN)
    await assertFails(getDoc(doc(db, 'rooms', ROOM)))
    await assertFails(getDocs(query(collection(db, 'guestRequests'), where('stayId', '==', S1))))
    await assertFails(getDocs(query(collection(db, 'guestRequests'), where('stayId', '==', 'stay-three'))))
  })

  it('the same guest re-checked in (same number, new stay) sees only the new stay', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), 'rooms', ROOM), { active_bill_id: 'stay-three' }))
    const db = anon(PHONE_IN)
    await assertSucceeds(getDocs(query(collection(db, 'guestRequests'), where('stayId', '==', 'stay-three'))))
    await assertFails(getDocs(query(collection(db, 'guestRequests'), where('stayId', '==', S1))))
  })

  it('a session Flask stamped closed is dead even while the room is occupied', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), 'guestSessions', PHONE_IN), { status: 'closed' }))
    const db = anon(PHONE_IN)
    await assertFails(getDoc(doc(db, 'settings', 'guest_portal')))
    await assertFails(updateDoc(doc(db, 'guestSessions', PHONE_IN), { status: 'active' }))
  })

  it('the same phone can sign in again for a new room once its old session is dead', async () => {
    const db = anon(PHONE_IN)
    // Live session: cannot be swapped to another room.
    await bumpAttempts(db, PHONE_IN)
    await assertFails(setDoc(doc(db, 'guestSessions', PHONE_IN), { ...sessionDoc(ROOM_NUM, KEY2), uid: PHONE_IN }))
    // Checked out: a fresh login for room 206 with its number is fine.
    await env.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), 'rooms', ROOM), { status: 'cleaning', active_bill_id: null, guest: null }))
    await assertSucceeds(setDoc(doc(db, 'guestSessions', PHONE_IN), { ...sessionDoc(ROOM_NUM, KEY2), uid: PHONE_IN }))
    await assertSucceeds(getDoc(doc(db, 'rooms', ROOM_NUM)))
  })

  it('an expired session is dead and cannot be revived by the phone', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      updateDoc(doc(ctx.firestore(), 'guestSessions', PHONE_IN), { expiresAtMs: now() - 1000 }))
    const db = anon(PHONE_IN)
    await assertFails(updateDoc(doc(db, 'guestSessions', PHONE_IN), { lastActivityAtMs: now(), expiresAtMs: inAnHour() }))
    await assertFails(getDoc(doc(db, 'settings', 'guest_portal')))
  })
})

describe('staff side', () => {
  it('admin and manager read every request; nobody edits them from a browser', async () => {
    await assertSucceeds(getDocs(collection(staff('admin'), 'guestRequests')))
    await assertSucceeds(getDocs(query(collection(staff('manager'), 'guestRequests'), where('active', '==', true))))
    await assertFails(updateDoc(doc(staff('admin'), 'guestRequests', 'in-req'), { status: 'done', active: false }))
    await assertFails(updateDoc(doc(staff('manager'), 'guestRequests', 'in-req'), { status: 'done', active: false }))
  })

  it('housekeeping sees only its own team\'s requests', async () => {
    const db = staff('housekeeping')
    await assertSucceeds(getDocs(query(collection(db, 'guestRequests'), where('active', '==', true), where('team', '==', 'housekeeping'))))
    await assertFails(getDocs(query(collection(db, 'guestRequests'), where('active', '==', true))))
    await assertFails(getDoc(doc(db, 'guestRequests', 'old-req')))
  })

  it('portal settings: staff read, admin writes', async () => {
    await assertSucceeds(getDoc(doc(staff('housekeeping'), 'settings', 'guest_portal')))
    await assertSucceeds(updateDoc(doc(staff('admin'), 'settings', 'guest_portal'), { enabled: false }))
    await assertFails(updateDoc(doc(staff('manager'), 'settings', 'guest_portal'), { enabled: false }))
  })

  it('the dashboard listeners are role-scoped and never anonymous', async () => {
    await assertFails(getDoc(doc(nobody(), 'rooms', ROOM)))
    // A phone that only scanned the code has no session: no room for it.
    await assertFails(getDoc(doc(anon(PHONE), 'rooms', ROOM)))
    // A proven phone reads its own room only (covered above), never another.
    await assertFails(getDoc(doc(anon(PHONE_IN), 'rooms', ROOM_NUM)))
    await assertSucceeds(getDoc(doc(staff('housekeeping'), 'rooms', ROOM)))
    await assertFails(getDoc(doc(staff('housekeeping'), 'bills', 'b1')))
    await assertSucceeds(getDoc(doc(staff('manager'), 'daily_counters', '2026-09-26')))
    await assertFails(getDoc(doc(staff('housekeeping'), 'daily_counters', '2026-09-26')))
  })
})

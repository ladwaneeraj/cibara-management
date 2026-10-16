/**
 * Room-card state, ported from static/script.js renderRooms (contract §2).
 * Pure functions so they are unit-tested in isolation.
 */
import type { Room, Upcoming } from '@/lib/types'

export type Filter = 'all' | 'vacant' | 'occupied' | 'cleaning' | 'balances'

export function matchesFilter(r: Room, f: Filter, search: string): boolean {
  const sc = r.service_cleaning || {}
  if (f === 'vacant' && r.status !== 'vacant') return false
  if (f === 'occupied' && r.status !== 'occupied') return false
  if (f === 'cleaning' && !(r.status === 'cleaning' || sc.room || sc.bathroom)) return false
  if (f === 'balances' && !(r.status === 'occupied' && (r.balance || 0) > 0 && !r._mmt_prepaid)) return false
  const q = search.trim().toLowerCase()
  if (q && !r.id.toLowerCase().includes(q) && !(r.guest?.name || '').toLowerCase().includes(q)) return false
  return true
}

export function isPremium(roomId: string) {
  const n = Number(roomId)
  return n >= 200 && n <= 206
}

export function isPhotoRoom(roomId: string) {
  const n = Number(roomId)
  return n >= 200 && n <= 228
}

export function floorOf(roomId: string): string {
  const n = Number(roomId)
  return Number.isFinite(n) && n >= 100 ? 'Second floor' : 'First floor'
}

export type CardTone = 'vacant' | 'occupied' | 'cleaning' | 'inspect'

export function cardTone(r: Room): CardTone {
  if (r.status === 'cleaning') return r.cleaning_status === 'ready_to_inspect' ? 'inspect' : 'cleaning'
  if (r.status === 'occupied') return 'occupied'
  return 'vacant'
}

export function arrivalTone(u?: Upcoming): 'red' | 'amber' | 'blue' | null {
  if (!u) return null
  if (u.hours_until <= 3) return 'red'
  if (u.hours_until <= 6) return 'amber'
  return 'blue'
}

/** Countdown label shown when ≤2h remain (legacy behaviour). */
export function renewalLabel(r: Room): { text: string; urgent: boolean } | null {
  const rn = r._renewal
  if (!rn || r.status !== 'occupied') return null
  if (rn.due) return { text: 'Renewal due', urgent: true }
  if (rn.minutes_left != null && rn.minutes_left <= 120) {
    const h = Math.floor(rn.minutes_left / 60)
    const m = rn.minutes_left % 60
    return { text: h ? `${h}h ${m}m left` : `${m}m left`, urgent: rn.minutes_left < 30 }
  }
  return null
}

export function elapsedSince(ts?: string | null, now = new Date()): number | null {
  if (!ts) return null
  const t = new Date(`${ts.replace(' ', 'T').slice(0, 19)}+05:30`)
  if (Number.isNaN(t.getTime())) return null
  return Math.max(0, Math.round((now.getTime() - t.getTime()) / 60000))
}

/** QC checklist keys by room (static/room-cleaning.js:61-94). */
export function checklistFor(roomId: string): { key: string; label: string }[] {
  const n = Number(roomId)
  if (n >= 200 && n <= 206) return [{ key: 'washroom', label: 'Washroom clean' }, { key: 'coffee', label: 'Coffee maker ready' }, { key: 'towels', label: 'Fresh towels' }]
  if (n >= 207 && n <= 228) return [{ key: 'washroom', label: 'Washroom clean' }, { key: 'dustbin', label: 'Dustbin emptied' }, { key: 'towels', label: 'Fresh towels' }]
  return [{ key: 'room_ready', label: 'Room ready' }]
}

export function photoKindsFor(roomId: string): ('washroom' | 'coffee' | 'bed')[] {
  if (!isPhotoRoom(roomId)) return []
  return isPremium(roomId) ? ['washroom', 'coffee', 'bed'] : ['washroom', 'bed']
}

/** Whether the server will demand photos (services/room_photos policy). */
export function photosRequired(roomId: string, role: string, ui: Record<string, boolean>, step: 'cleaned' | 'ready'): boolean {
  if (role === 'admin' || !isPhotoRoom(roomId)) return false
  if (step === 'ready') return role === 'manager' && ui.inspection_photos !== false
  return role === 'housekeeping' && ui.cleaning_photos === true
}

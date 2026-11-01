// Pure filter/sort/search/group functions. applyFilter + sortBookings mirror
// static/booking.js:1281-1352 exactly (parity). buildBookingGroupIndex mirrors
// booking.js:1507-1518. Single source of truth consumed by the list, calendar,
// search/sort bar and group view.
import type { Booking } from '../types/booking'

export type BookingFilter = 'upcoming' | 'today' | 'all' | 'completed' | 'cancelled'

function startOfToday(): number {
  const t = new Date()
  t.setHours(0, 0, 0, 0)
  return t.getTime()
}

function checkInDayStart(b: Booking): number {
  const d = new Date(b.check_in_date)
  if (Number.isNaN(d.getTime())) return NaN
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// NOTE (deviation from booking.js, deliberate): the classic filter toggled
// only ONE status's visibility per tab, so "Checked In" and "Cancelled" also
// leaked confirmed bookings and "All" hid checked-in/cancelled. That is a bug,
// not intended behaviour. The island implements each pill's plain meaning:
//   upcoming  = confirmed, check-in today or later
//   today     = confirmed, check-in today
//   completed = checked-in ("Checked In" pill)
//   cancelled = cancelled
//   all       = every status
export function applyFilter(bookings: Booking[], filter: BookingFilter): Booking[] {
  const today = startOfToday()
  return bookings.filter((booking) => {
    switch (filter) {
      case 'upcoming': {
        const ci = checkInDayStart(booking)
        return booking.status === 'confirmed' && !Number.isNaN(ci) && ci >= today
      }
      case 'today': {
        const ci = checkInDayStart(booking)
        return booking.status === 'confirmed' && ci === today
      }
      case 'completed':
        return booking.status === 'checked_in'
      case 'cancelled':
        return booking.status === 'cancelled'
      case 'all':
      default:
        return true
    }
  })
}

export function sortBookings(list: Booking[], filter: BookingFilter): Booking[] {
  const past = filter === 'completed' || filter === 'cancelled'
  return [...list].sort((a, b) => {
    const da = new Date(a.check_in_date).getTime()
    const db = new Date(b.check_in_date).getTime()
    if (past) {
      if (db !== da) return db - da
      const ta = a.check_in_time || '23:59'
      const tb = b.check_in_time || '23:59'
      return tb.localeCompare(ta)
    }
    if (da !== db) return da - db
    const ta = a.check_in_time || '00:00'
    const tb = b.check_in_time || '00:00'
    return ta.localeCompare(tb)
  })
}

export function searchBookings(list: Booking[], query: string): Booking[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter((b) =>
    [b.guest_name, b.guest_mobile, b.room].some((f) =>
      String(f ?? '').toLowerCase().includes(q),
    ),
  )
}

export function buildBookingGroupIndex(source: Booking[]): Map<string, Booking[]> {
  const index = new Map<string, Booking[]>()
  for (const b of source) {
    if (!b.group_booking_id || b.status === 'cancelled') continue
    if (!index.has(b.group_booking_id)) index.set(b.group_booking_id, [])
    index.get(b.group_booking_id)!.push(b)
  }
  for (const list of index.values()) {
    list.sort((a, b) => String(a.room).localeCompare(String(b.room), undefined, { numeric: true }))
  }
  return index
}

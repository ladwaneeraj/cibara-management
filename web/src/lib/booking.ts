// Small booking helpers shared by the card, drawer and modals.
import type { Booking, BookingSource } from '../types/booking'
import { buildBookingGroupIndex } from './bookingFilters'

const OTA_PREPAID: BookingSource[] = ['mmt', 'agoda']

// Mirrors booking.js isOtaPrepaid: prepaid OTA sources behave identically in
// the UI (prepaid, settles via the OTA, no money collected at the hotel).
export function isOtaPrepaid(src?: BookingSource): boolean {
  return !!src && OTA_PREPAID.includes(src)
}

export function otaSourceLabel(src?: BookingSource): string {
  if (src === 'mmt') return 'MMT'
  if (src === 'agoda') return 'Agoda'
  return (src ?? '').toUpperCase()
}

export type PaymentState = 'paid' | 'partial' | 'unpaid'

export function paymentLabel(b: Pick<Booking, 'paid_amount' | 'total_amount'>): PaymentState {
  if (b.paid_amount === b.total_amount) return 'paid'
  if (b.paid_amount > 0) return 'partial'
  return 'unpaid'
}

export function bookingBalance(b: Booking): number {
  return b.balance != null ? b.balance : (b.total_amount || 0) - (b.paid_amount || 0)
}

// Guest mobiles that appear on more than one booking → "repeat guest" badge.
export function repeatGuestMobiles(all: Booking[]): Set<string> {
  const counts = new Map<string, number>()
  for (const b of all) {
    const m = (b.guest_mobile || '').trim()
    if (!m) continue
    counts.set(m, (counts.get(m) ?? 0) + 1)
  }
  const repeats = new Set<string>()
  for (const [m, n] of counts) if (n > 1) repeats.add(m)
  return repeats
}

// Non-cancelled members that share this booking's group (sorted by room).
// Returns [booking] for a plain single-room booking. Mirrors booking.js
// getBookingGroupMembers.
export function getGroupMembers(all: Booking[], booking: Booking): Booking[] {
  if (!booking.group_booking_id) return [booking]
  const members = buildBookingGroupIndex(all).get(booking.group_booking_id) ?? []
  return members.length ? members : [booking]
}

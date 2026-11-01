import { applyFilter, buildBookingGroupIndex, searchBookings, sortBookings } from './bookingFilters'
import type { Booking } from '../types/booking'

function b(partial: Partial<Booking>): Booking {
  return {
    booking_id: Math.random().toString(36).slice(2),
    room: '101',
    guest_name: 'Guest',
    guest_mobile: '9000000000',
    check_in_date: '2026-11-05',
    check_out_date: '2026-11-06',
    status: 'confirmed',
    booking_source: 'normal',
    total_amount: 1000,
    paid_amount: 0,
    balance: 1000,
    ...partial,
  }
}

const today = new Date()
today.setHours(0, 0, 0, 0)
const iso = (d: Date) => d.toISOString().slice(0, 10)
const plusDays = (n: number) => {
  const d = new Date(today)
  d.setDate(d.getDate() + n)
  return iso(d)
}

describe('applyFilter (parity with booking.js)', () => {
  it('upcoming shows only confirmed with check-in today or later', () => {
    const list = [
      b({ status: 'confirmed', check_in_date: plusDays(2) }),
      b({ status: 'confirmed', check_in_date: plusDays(-2) }),
      b({ status: 'checked_in', check_in_date: plusDays(1) }),
      b({ status: 'cancelled', check_in_date: plusDays(1) }),
    ]
    const out = applyFilter(list, 'upcoming')
    expect(out).toHaveLength(1)
    expect(out[0].check_in_date).toBe(plusDays(2))
  })

  it('today shows confirmed bookings checking in today', () => {
    const list = [b({ check_in_date: plusDays(0) }), b({ check_in_date: plusDays(1) })]
    expect(applyFilter(list, 'today')).toHaveLength(1)
  })

  it('completed shows checked_in only; cancelled shows cancelled only', () => {
    const list = [
      b({ status: 'checked_in' }),
      b({ status: 'cancelled' }),
      b({ status: 'confirmed' }),
    ]
    expect(applyFilter(list, 'completed').map((x) => x.status)).toEqual(['checked_in'])
    expect(applyFilter(list, 'cancelled').map((x) => x.status)).toEqual(['cancelled'])
  })

  it('all shows every status (fixed semantics)', () => {
    const list = [
      b({ status: 'confirmed' }),
      b({ status: 'checked_out' }),
      b({ status: 'checked_in' }),
      b({ status: 'cancelled' }),
    ]
    expect(applyFilter(list, 'all')).toHaveLength(4)
  })

  it('does not throw on a malformed check_in_date', () => {
    const list = [b({ check_in_date: 'not-a-date', status: 'confirmed' })]
    expect(() => applyFilter(list, 'upcoming')).not.toThrow()
  })
})

describe('sortBookings (parity with booking.js)', () => {
  it('upcoming: soonest date first, earliest time on ties (missing time = 00:00)', () => {
    const list = [
      b({ booking_id: 'late', check_in_date: '2026-11-07', check_in_time: '10:00' }),
      b({ booking_id: 'early-am', check_in_date: '2026-11-05', check_in_time: '08:00' }),
      b({ booking_id: 'early-notime', check_in_date: '2026-11-05' }),
    ]
    expect(sortBookings(list, 'upcoming').map((x) => x.booking_id)).toEqual([
      'early-notime',
      'early-am',
      'late',
    ])
  })

  it('completed/cancelled: most recent date first, latest time on ties (missing time = 23:59)', () => {
    const list = [
      b({ booking_id: 'old', check_in_date: '2026-11-05', check_in_time: '10:00' }),
      b({ booking_id: 'new-pm', check_in_date: '2026-11-07', check_in_time: '18:00' }),
      b({ booking_id: 'new-notime', check_in_date: '2026-11-07' }),
    ]
    expect(sortBookings(list, 'completed').map((x) => x.booking_id)).toEqual([
      'new-notime',
      'new-pm',
      'old',
    ])
  })
})

describe('searchBookings', () => {
  const list = [
    b({ guest_name: 'Asha Rao', guest_mobile: '9811111111', room: '201' }),
    b({ guest_name: 'Bimal', guest_mobile: '9822222222', room: '305' }),
  ]
  it('matches guest name, phone, or room (case-insensitive)', () => {
    expect(searchBookings(list, 'asha')).toHaveLength(1)
    expect(searchBookings(list, '982')).toHaveLength(1)
    expect(searchBookings(list, '305')).toHaveLength(1)
    expect(searchBookings(list, '')).toHaveLength(2)
  })
})

describe('buildBookingGroupIndex', () => {
  it('groups non-cancelled bookings by group_booking_id, members sorted by room', () => {
    const list = [
      b({ booking_id: 'g2', group_booking_id: 'G', room: '305' }),
      b({ booking_id: 'g1', group_booking_id: 'G', room: '201' }),
      b({ booking_id: 'gc', group_booking_id: 'G', room: '101', status: 'cancelled' }),
      b({ booking_id: 's1' }),
    ]
    const idx = buildBookingGroupIndex(list)
    expect(idx.get('G')?.map((x) => x.room)).toEqual(['201', '305'])
    expect(idx.has(undefined as unknown as string)).toBe(false)
  })
})

import { buildMonthGrid, formatDateForAPI, isDateInBookingRange } from './calendar'
import type { Booking } from '../types/booking'

function b(p: Partial<Booking>): Booking {
  return {
    booking_id: Math.random().toString(36).slice(2),
    room: '101',
    guest_name: 'Guest',
    guest_mobile: '9',
    check_in_date: '2026-11-05',
    check_out_date: '2026-11-07',
    status: 'confirmed',
    booking_source: 'normal',
    total_amount: 0,
    paid_amount: 0,
    balance: 0,
    ...p,
  }
}

describe('isDateInBookingRange (parity: checkout day excluded)', () => {
  it('includes check-in and nights, excludes the checkout day', () => {
    expect(isDateInBookingRange('2026-11-05', '2026-11-05', '2026-11-07')).toBe(true)
    expect(isDateInBookingRange('2026-11-06', '2026-11-05', '2026-11-07')).toBe(true)
    expect(isDateInBookingRange('2026-11-07', '2026-11-05', '2026-11-07')).toBe(false)
    expect(isDateInBookingRange('2026-11-04', '2026-11-05', '2026-11-07')).toBe(false)
  })
})

describe('formatDateForAPI', () => {
  it('formats a local date as YYYY-MM-DD', () => {
    expect(formatDateForAPI(new Date(2026, 10, 5))).toBe('2026-11-05')
  })
})

describe('buildMonthGrid', () => {
  const view = new Date(2026, 10, 1) // November 2026

  it('returns whole weeks (length is a multiple of 7)', () => {
    const grid = buildMonthGrid(view, [])
    expect(grid.length % 7).toBe(0)
  })

  it('places a booking on its occupied days, not the checkout day', () => {
    const grid = buildMonthGrid(view, [b({ check_in_date: '2026-11-05', check_out_date: '2026-11-07' })])
    const d5 = grid.find((c) => c.dateStr === '2026-11-05')
    const d7 = grid.find((c) => c.dateStr === '2026-11-07')
    expect(d5?.bookings).toHaveLength(1)
    expect(d7?.bookings).toHaveLength(0)
  })

  it('excludes cancelled bookings from day cells', () => {
    const grid = buildMonthGrid(view, [b({ check_in_date: '2026-11-10', check_out_date: '2026-11-11', status: 'cancelled' })])
    expect(grid.find((c) => c.dateStr === '2026-11-10')?.bookings).toHaveLength(0)
  })

  it('flags today', () => {
    const today = new Date(2026, 10, 15)
    const grid = buildMonthGrid(view, [], today)
    expect(grid.find((c) => c.dateStr === '2026-11-15')?.isToday).toBe(true)
  })
})

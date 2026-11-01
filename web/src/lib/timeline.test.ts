import { buildTimeline } from './timeline'
import type { Booking } from '../types/booking'

function b(p: Partial<Booking>): Booking {
  return {
    booking_id: Math.random().toString(36).slice(2),
    room: '101',
    guest_name: 'G',
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

const start = new Date(2026, 10, 5) // 2026-11-05

it('lays a booking at the right offset and length within the window', () => {
  const { dates, lanes } = buildTimeline(
    [b({ room: '101', check_in_date: '2026-11-06', check_out_date: '2026-11-08' })],
    ['101'],
    start,
    7,
  )
  expect(dates).toHaveLength(7)
  const span = lanes[0].spans[0]
  expect(span.startIndex).toBe(1) // one day after the window start
  expect(span.length).toBe(2) // two nights
})

it('flags overlapping bookings on the same room as conflicts', () => {
  const { lanes } = buildTimeline(
    [
      b({ booking_id: 'a', room: '101', check_in_date: '2026-11-05', check_out_date: '2026-11-08' }),
      b({ booking_id: 'c', room: '101', check_in_date: '2026-11-07', check_out_date: '2026-11-09' }),
    ],
    ['101'],
    start,
    7,
  )
  expect(lanes[0].spans.every((s) => s.conflict)).toBe(true)
})

it('does not flag back-to-back (checkout == next check-in) as a conflict', () => {
  const { lanes } = buildTimeline(
    [
      b({ booking_id: 'a', room: '101', check_in_date: '2026-11-05', check_out_date: '2026-11-07' }),
      b({ booking_id: 'c', room: '101', check_in_date: '2026-11-07', check_out_date: '2026-11-09' }),
    ],
    ['101'],
    start,
    7,
  )
  expect(lanes[0].spans.some((s) => s.conflict)).toBe(false)
})

it('excludes cancelled bookings', () => {
  const { lanes } = buildTimeline(
    [b({ room: '101', status: 'cancelled' })],
    ['101'],
    start,
    7,
  )
  expect(lanes[0].spans).toHaveLength(0)
})

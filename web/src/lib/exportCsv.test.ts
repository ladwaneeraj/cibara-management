import { exportCsv } from './exportCsv'
import type { Booking } from '../types/booking'

function b(p: Partial<Booking>): Booking {
  return {
    booking_id: 'b1', room: '201', guest_name: 'Guest', guest_mobile: '9811111111',
    check_in_date: '2026-11-05', check_out_date: '2026-11-07', check_in_time: '14:00',
    status: 'confirmed', booking_source: 'normal',
    total_amount: 1200, paid_amount: 200, balance: 1000, ...p,
  }
}

it('emits a header and one row per booking', () => {
  const csv = exportCsv([b({}), b({ booking_id: 'b2' })])
  const lines = csv.trim().split('\n')
  expect(lines[0]).toContain('Booking ID')
  expect(lines).toHaveLength(3)
})

it('quotes fields containing commas or quotes', () => {
  const csv = exportCsv([b({ guest_name: 'Rao, Asha "A"' })])
  expect(csv).toContain('"Rao, Asha ""A"""')
})

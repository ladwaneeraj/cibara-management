import { groupCheckin } from './groupCheckin'
import type { Booking } from '../types/booking'

function b(p: Partial<Booking>): Booking {
  return {
    booking_id: 'x', room: '101', guest_name: 'G', guest_mobile: '9',
    check_in_date: '2026-11-05', check_out_date: '2026-11-06',
    status: 'confirmed', booking_source: 'normal',
    total_amount: 0, paid_amount: 0, balance: 0, ...p,
  }
}

it('converts each confirmed member and reports per-room results', async () => {
  const members = [
    b({ booking_id: 'a', room: '101' }),
    b({ booking_id: 'c', room: '102' }),
    b({ booking_id: 'done', room: '103', status: 'checked_in' }), // skipped
  ]
  const convert = vi.fn().mockResolvedValue(undefined)
  const results = await groupCheckin(members, convert)
  expect(convert).toHaveBeenCalledTimes(2)
  expect(results).toEqual([
    { room: '101', ok: true },
    { room: '102', ok: true },
  ])
})

it('records a per-room failure without aborting the rest', async () => {
  const members = [b({ booking_id: 'a', room: '101' }), b({ booking_id: 'c', room: '102' })]
  const convert = vi
    .fn()
    .mockRejectedValueOnce(new Error('room busy'))
    .mockResolvedValueOnce(undefined)
  const results = await groupCheckin(members, convert)
  expect(results).toEqual([
    { room: '101', ok: false, error: 'room busy' },
    { room: '102', ok: true },
  ])
})

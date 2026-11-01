import { act, renderHook, waitFor } from '@testing-library/react'
import * as api from '../api/bookings'
import type { Booking } from '../types/booking'
import { useBookings } from './useBookings'

vi.mock('../api/bookings')
const mockGet = vi.mocked(api.getBookings)

const sample = (id: string): Booking =>
  ({
    booking_id: id,
    room: '101',
    guest_name: 'G',
    guest_mobile: '9',
    check_in_date: '2026-11-05',
    check_out_date: '2026-11-06',
    status: 'confirmed',
    booking_source: 'normal',
    total_amount: 0,
    paid_amount: 0,
    balance: 0,
  }) as Booking

afterEach(() => vi.resetAllMocks())

it('loads bookings on mount', async () => {
  mockGet.mockResolvedValue([sample('b1')])
  const { result } = renderHook(() => useBookings())
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.bookings).toHaveLength(1)
  expect(result.current.error).toBeNull()
  expect(result.current.lastUpdated).toBeTypeOf('number')
})

it('keeps last good data and sets error when a refresh fails', async () => {
  mockGet.mockResolvedValueOnce([sample('b1')])
  const { result } = renderHook(() => useBookings())
  await waitFor(() => expect(result.current.bookings).toHaveLength(1))

  mockGet.mockRejectedValueOnce(new Error('boom'))
  await act(async () => {
    await result.current.refresh()
  })
  expect(result.current.error).toBe('boom')
  expect(result.current.bookings).toHaveLength(1)
})

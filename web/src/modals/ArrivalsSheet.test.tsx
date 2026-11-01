import { render, screen } from '@testing-library/react'
import * as api from '../api/bookings'
import type { Booking } from '../types/booking'
import { ArrivalsSheet } from './ArrivalsSheet'

vi.mock('../api/bookings')

const arrival: Booking = {
  booking_id: 'b1', room: '201', guest_name: 'Asha', guest_mobile: '9811111111',
  check_in_date: '2026-11-05', check_in_time: '14:00', check_out_date: '2026-11-07',
  status: 'confirmed', booking_source: 'normal',
  total_amount: 1000, paid_amount: 0, balance: 1000,
}

afterEach(() => vi.resetAllMocks())

it('lists upcoming arrivals from get_upcoming_bookings_list', async () => {
  vi.mocked(api.getUpcomingList).mockResolvedValue([arrival])
  render(<ArrivalsSheet onClose={() => {}} />)
  expect(await screen.findByText('Asha')).toBeInTheDocument()
  expect(screen.getByText(/201/)).toBeInTheDocument()
})

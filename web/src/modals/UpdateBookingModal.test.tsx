import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../api/bookings'
import type { Booking } from '../types/booking'
import { UpdateBookingModal } from './UpdateBookingModal'

vi.mock('../api/bookings')

const booking: Booking = {
  booking_id: 'b1', room: '201', guest_name: 'Asha', guest_mobile: '9811111111',
  check_in_date: '2026-11-05', check_out_date: '2026-11-07', check_in_time: '14:00',
  status: 'confirmed', booking_source: 'normal', guest_count: 1,
  total_amount: 1000, paid_amount: 0, balance: 1000, notes: '',
}

afterEach(() => vi.resetAllMocks())

it('submits edited fields through update_booking', async () => {
  vi.mocked(api.updateBooking).mockResolvedValue({})
  const onDone = vi.fn()
  render(<UpdateBookingModal booking={booking} onClose={() => {}} onDone={onDone} />)
  const name = screen.getByLabelText(/guest name/i)
  await userEvent.clear(name)
  await userEvent.type(name, 'Asha Rao')
  await userEvent.click(screen.getByRole('button', { name: /Save changes/i }))
  await waitFor(() => expect(onDone).toHaveBeenCalled())
  expect(api.updateBooking).toHaveBeenCalledWith(
    expect.objectContaining({ booking_id: 'b1', guest_name: 'Asha Rao' }),
  )
})

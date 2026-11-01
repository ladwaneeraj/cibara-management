import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../api/bookings'
import type { Booking } from '../types/booking'
import { PaymentModal } from './PaymentModal'

vi.mock('../api/bookings')

const booking: Booking = {
  booking_id: 'b1', room: '201', guest_name: 'Asha', guest_mobile: '9',
  check_in_date: '2026-11-05', check_out_date: '2026-11-07',
  status: 'confirmed', booking_source: 'normal',
  total_amount: 1000, paid_amount: 200, balance: 800,
}

afterEach(() => vi.resetAllMocks())

it('posts a single payment and calls onDone', async () => {
  vi.mocked(api.updateBooking).mockResolvedValue({})
  const onDone = vi.fn()
  render(<PaymentModal booking={booking} onClose={() => {}} onDone={onDone} />)
  await userEvent.type(screen.getByLabelText(/amount/i), '500')
  await userEvent.click(screen.getByRole('button', { name: /^Collect/ }))
  await waitFor(() => expect(onDone).toHaveBeenCalled())
  expect(api.updateBooking).toHaveBeenCalledTimes(1)
  expect(api.updateBooking).toHaveBeenCalledWith(
    expect.objectContaining({ booking_id: 'b1', new_payment: 500 }),
  )
})

it('shows the server error and does not call onDone', async () => {
  vi.mocked(api.updateBooking).mockRejectedValue(new Error('month locked'))
  const onDone = vi.fn()
  render(<PaymentModal booking={booking} onClose={() => {}} onDone={onDone} />)
  await userEvent.type(screen.getByLabelText(/amount/i), '500')
  await userEvent.click(screen.getByRole('button', { name: /^Collect/ }))
  expect(await screen.findByText(/month locked/)).toBeInTheDocument()
  expect(onDone).not.toHaveBeenCalled()
})

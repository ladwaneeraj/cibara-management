import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../api/bookings'
import type { Booking } from '../types/booking'
import { CancelModal } from './CancelModal'

vi.mock('../api/bookings')

const booking: Booking = {
  booking_id: 'b1', room: '201', guest_name: 'Asha', guest_mobile: '9',
  check_in_date: '2026-11-05', check_out_date: '2026-11-07',
  status: 'confirmed', booking_source: 'normal',
  total_amount: 1000, paid_amount: 500, balance: 500,
}

afterEach(() => vi.resetAllMocks())

it('rejects a refund greater than the paid amount without calling the API', async () => {
  render(<CancelModal booking={booking} onClose={() => {}} onDone={() => {}} />)
  await userEvent.type(screen.getByLabelText(/refund/i), '600')
  await userEvent.click(screen.getByRole('button', { name: /Confirm cancellation/i }))
  expect(await screen.findByText(/exceed/i)).toBeInTheDocument()
  expect(api.cancelBooking).not.toHaveBeenCalled()
})

it('sends retain_as_charge and surfaces the cancellation invoice number', async () => {
  vi.mocked(api.cancelBooking).mockResolvedValue({ charge_bill_number: 'CC/2026/11/00007' })
  render(<CancelModal booking={booking} onClose={() => {}} onDone={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: /Confirm cancellation/i }))
  await waitFor(() => expect(api.cancelBooking).toHaveBeenCalledTimes(1))
  expect(api.cancelBooking).toHaveBeenCalledWith(expect.objectContaining({ booking_id: 'b1' }))
  expect(await screen.findByText(/CC\/2026\/11\/00007/)).toBeInTheDocument()
})

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../api/bookings'
import type { Booking } from '../types/booking'
import { ConvertCheckinModal } from './ConvertCheckinModal'

vi.mock('../api/bookings')

const booking: Booking = {
  booking_id: 'b1', room: '201', guest_name: 'Asha', guest_mobile: '9',
  check_in_date: '2026-11-05', check_out_date: '2026-11-07',
  status: 'confirmed', booking_source: 'normal',
  total_amount: 1000, paid_amount: 200, balance: 800,
}

afterEach(() => vi.resetAllMocks())

it('blocks Pay Later combined with an amount', async () => {
  render(<ConvertCheckinModal booking={booking} onClose={() => {}} onDone={() => {}} />)
  await userEvent.type(screen.getByLabelText(/amount/i), '300')
  await userEvent.click(screen.getByRole('button', { name: /Pay Later/i }))
  await userEvent.click(screen.getByRole('button', { name: /Check in/i }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/Pay Later/i)
  expect(api.convertToCheckin).not.toHaveBeenCalled()
})

it('checks the guest in with a cash payment', async () => {
  vi.mocked(api.convertToCheckin).mockResolvedValue({})
  const onDone = vi.fn()
  render(<ConvertCheckinModal booking={booking} onClose={() => {}} onDone={onDone} />)
  await userEvent.type(screen.getByLabelText(/amount/i), '300')
  await userEvent.click(screen.getByRole('button', { name: /Check in/i }))
  await waitFor(() => expect(onDone).toHaveBeenCalled())
  expect(api.convertToCheckin).toHaveBeenCalledWith(
    expect.objectContaining({ booking_id: 'b1', remaining_payment: 300, payment_method: 'cash' }),
  )
})

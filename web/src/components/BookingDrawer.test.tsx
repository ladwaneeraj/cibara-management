import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BookingDrawer } from './BookingDrawer'
import type { Booking } from '../types/booking'

const booking: Booking = {
  booking_id: 'b1',
  room: '201',
  guest_name: 'Asha Rao',
  guest_mobile: '9811111111',
  check_in_date: '2026-11-05',
  check_out_date: '2026-11-07',
  check_in_time: '14:00',
  status: 'confirmed',
  booking_source: 'normal',
  total_amount: 1200,
  paid_amount: 200,
  balance: 1000,
}

it('renders nothing when no booking is selected', () => {
  const { container } = render(<BookingDrawer booking={null} onAction={() => {}} onClose={() => {}} />)
  expect(container).toBeEmptyDOMElement()
})

it('shows guest, room, dates and amounts', () => {
  render(<BookingDrawer booking={booking} onAction={() => {}} onClose={() => {}} />)
  expect(screen.getByText(/Room 201/)).toBeInTheDocument()
  expect(screen.getByText('Asha Rao')).toBeInTheDocument()
  expect(screen.getByText(/₹1,000/)).toBeInTheDocument() // balance
})

it('calls onClose from the close button', async () => {
  const onClose = vi.fn()
  render(<BookingDrawer booking={booking} onAction={() => {}} onClose={onClose} />)
  await userEvent.click(screen.getByRole('button', { name: /close/i }))
  expect(onClose).toHaveBeenCalled()
})

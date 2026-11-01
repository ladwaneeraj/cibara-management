import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BookingCard } from './BookingCard'
import type { Booking } from '../types/booking'

function b(p: Partial<Booking>): Booking {
  return {
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
    paid_amount: 0,
    balance: 1200,
    ...p,
  }
}

it('shows room, guest and a rupee amount for a walk-in', () => {
  render(<BookingCard booking={b({})} onOpen={() => {}} />)
  expect(screen.getByText(/Room 201/)).toBeInTheDocument()
  expect(screen.getByText('Asha Rao')).toBeInTheDocument()
  expect(screen.getByText('₹1200')).toBeInTheDocument()
  expect(screen.getByText(/1200 due/)).toBeInTheDocument()
})

it('shows an OTA badge and OTA amount, and no balance-due note, for an MMT booking', () => {
  render(<BookingCard booking={b({ booking_source: 'mmt', balance: 1200 })} onOpen={() => {}} />)
  expect(screen.getByText('MMT')).toBeInTheDocument()
  expect(screen.getByText('OTA')).toBeInTheDocument()
  expect(screen.queryByText(/due/)).not.toBeInTheDocument()
})

it('labels checked_out and no_show statuses', () => {
  const { rerender } = render(<BookingCard booking={b({ status: 'checked_out' })} onOpen={() => {}} />)
  expect(screen.getByText('Checked Out')).toBeInTheDocument()
  rerender(<BookingCard booking={b({ status: 'no_show' })} onOpen={() => {}} />)
  expect(screen.getByText('No Show')).toBeInTheDocument()
})

it('calls onOpen with the booking id when the card is activated', async () => {
  const onOpen = vi.fn()
  render(<BookingCard booking={b({ booking_id: 'xyz' })} onOpen={onOpen} />)
  await userEvent.click(screen.getByRole('button'))
  expect(onOpen).toHaveBeenCalledWith('xyz')
})

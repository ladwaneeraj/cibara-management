import { render, screen } from '@testing-library/react'
import { ListView } from './ListView'
import type { Booking } from '../types/booking'

function b(p: Partial<Booking>): Booking {
  return {
    booking_id: Math.random().toString(36).slice(2),
    room: '101',
    guest_name: 'Guest',
    guest_mobile: '9',
    check_in_date: '2026-11-05',
    check_out_date: '2026-11-06',
    status: 'confirmed',
    booking_source: 'normal',
    total_amount: 1000,
    paid_amount: 0,
    balance: 1000,
    ...p,
  }
}

const future = () => {
  const d = new Date()
  d.setDate(d.getDate() + 3)
  return d.toISOString().slice(0, 10)
}

it('renders a card per booking matching the filter', () => {
  const list = [
    b({ guest_name: 'Future Guest', check_in_date: future() }),
    b({ guest_name: 'Cancelled Guest', status: 'cancelled' }),
  ]
  render(<ListView bookings={list} filter="upcoming" query="" onOpen={() => {}} />)
  expect(screen.getByText('Future Guest')).toBeInTheDocument()
  expect(screen.queryByText('Cancelled Guest')).not.toBeInTheDocument()
})

it('shows an empty state when nothing matches', () => {
  render(<ListView bookings={[]} filter="upcoming" query="" onOpen={() => {}} />)
  expect(screen.getByText(/No upcoming bookings/i)).toBeInTheDocument()
})

it('filters by the search query', () => {
  const list = [
    b({ guest_name: 'Asha', check_in_date: future() }),
    b({ guest_name: 'Bimal', check_in_date: future() }),
  ]
  render(<ListView bookings={list} filter="upcoming" query="asha" onOpen={() => {}} />)
  expect(screen.getByText('Asha')).toBeInTheDocument()
  expect(screen.queryByText('Bimal')).not.toBeInTheDocument()
})

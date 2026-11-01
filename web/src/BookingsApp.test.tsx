import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from './api/bookings'
import type { Booking } from './types/booking'
import { BookingsApp } from './BookingsApp'

vi.mock('./api/bookings')
const mockGet = vi.mocked(api.getBookings)

function b(p: Partial<Booking>): Booking {
  return {
    booking_id: Math.random().toString(36).slice(2),
    room: '101',
    guest_name: 'Guest',
    guest_mobile: '9000000000',
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

afterEach(() => {
  vi.resetAllMocks()
  delete (window as unknown as { CibaraAuth?: unknown }).CibaraAuth
})

it('renders 5 filter pills, 3 view buttons and the toolbar', async () => {
  mockGet.mockResolvedValue([])
  render(<BookingsApp />)
  await waitFor(() => expect(screen.getByText('Room Bookings')).toBeInTheDocument())
  expect(screen.getAllByRole('button', { name: /Upcoming|Today|All|Checked In|Cancelled/ })).toHaveLength(5)
  expect(screen.getByRole('button', { name: /New Booking/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Arrivals Sheet/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Fetch Bookings/ })).toBeInTheDocument()
})

it('switches the list when a filter pill is clicked', async () => {
  mockGet.mockResolvedValue([
    b({ guest_name: 'Future Guest', check_in_date: future() }),
    b({ guest_name: 'Cancelled Guest', status: 'cancelled' }),
  ])
  render(<BookingsApp />)
  await waitFor(() => expect(screen.getByText('Future Guest')).toBeInTheDocument())
  expect(screen.queryByText('Cancelled Guest')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Cancelled' }))
  expect(screen.getByText('Cancelled Guest')).toBeInTheDocument()
})

it('hides OTA Settlements without settlement.manage permission', async () => {
  mockGet.mockResolvedValue([])
  window.CibaraAuth = { hasPermission: (p: string) => p !== 'settlement.manage' }
  render(<BookingsApp />)
  await waitFor(() => expect(screen.getByText('Room Bookings')).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: /OTA Settlements/ })).not.toBeInTheDocument()
})

it('shows OTA Settlements when permitted', async () => {
  mockGet.mockResolvedValue([])
  window.CibaraAuth = { hasPermission: () => true }
  render(<BookingsApp />)
  await waitFor(() => expect(screen.getByText('Room Bookings')).toBeInTheDocument())
  expect(screen.getByRole('button', { name: /OTA Settlements/ })).toBeInTheDocument()
})

it('installs the room-calendar bridge globals while mounted', async () => {
  mockGet.mockResolvedValue([])
  render(<BookingsApp />)
  await waitFor(() => expect(typeof window.showBookingDetails).toBe('function'))
  expect(typeof window.fetchBookings).toBe('function')
  expect(typeof window.showNewBookingModalForDate).toBe('function')
})

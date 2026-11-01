import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TimelineView } from './TimelineView'
import type { Booking } from '../types/booking'

function b(p: Partial<Booking>): Booking {
  return {
    booking_id: 'b1',
    room: '101',
    guest_name: 'Asha',
    guest_mobile: '9',
    check_in_date: '2026-11-05',
    check_out_date: '2026-11-07',
    status: 'confirmed',
    booking_source: 'normal',
    total_amount: 0,
    paid_amount: 0,
    balance: 0,
    ...p,
  }
}

const start = new Date(2026, 10, 5)

it('renders a bar for a booking and opens the drawer on click', async () => {
  const onOpen = vi.fn()
  render(
    <TimelineView
      bookings={[b({ booking_id: 'xyz', guest_name: 'Asha' })]}
      rooms={['101']}
      rangeStart={start}
      onOpen={onOpen}
      onNewForDate={() => {}}
    />,
  )
  const bar = await screen.findByRole('button', { name: /Asha/ })
  await userEvent.click(bar)
  expect(onOpen).toHaveBeenCalledWith('xyz')
})

it('shows an overbooking warning when two bookings on one room overlap', () => {
  render(
    <TimelineView
      bookings={[
        b({ booking_id: 'a', room: '101', check_in_date: '2026-11-05', check_out_date: '2026-11-08' }),
        b({ booking_id: 'c', room: '101', check_in_date: '2026-11-06', check_out_date: '2026-11-09' }),
      ]}
      rooms={['101']}
      rangeStart={start}
      onOpen={() => {}}
      onNewForDate={() => {}}
    />,
  )
  expect(screen.getByText(/overbook/i)).toBeInTheDocument()
})

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarView } from './CalendarView'
import type { Booking } from '../types/booking'

function b(p: Partial<Booking>): Booking {
  return {
    booking_id: 'b1',
    room: '201',
    guest_name: 'Asha',
    guest_mobile: '9',
    check_in_date: '2026-11-10',
    check_out_date: '2026-11-12',
    status: 'confirmed',
    booking_source: 'normal',
    total_amount: 0,
    paid_amount: 0,
    balance: 0,
    ...p,
  }
}

const nov = new Date(2026, 10, 1)

it('renders the month title', () => {
  render(<CalendarView bookings={[]} month={nov} onMonthChange={() => {}} onOpen={() => {}} />)
  expect(screen.getByText('November 2026')).toBeInTheDocument()
})

it('shows a booking count on a day with a booking', () => {
  const { container } = render(
    <CalendarView bookings={[b({})]} month={nov} onMonthChange={() => {}} onOpen={() => {}} />,
  )
  const cell = container.querySelector('[data-date="2026-11-10"]')
  expect(cell?.textContent).toContain('1 booking')
})

it('clicking a day shows its bookings; clicking one opens the drawer', async () => {
  const onOpen = vi.fn()
  const { container } = render(
    <CalendarView bookings={[b({ booking_id: 'xyz' })]} month={nov} onMonthChange={() => {}} onOpen={onOpen} />,
  )
  const cell = container.querySelector('[data-date="2026-11-10"]') as HTMLElement
  await userEvent.click(cell)
  const row = await screen.findByRole('button', { name: /Room 201 · Asha/ })
  await userEvent.click(row)
  expect(onOpen).toHaveBeenCalledWith('xyz')
})

it('prev / next move the month', async () => {
  const onMonthChange = vi.fn()
  render(<CalendarView bookings={[]} month={nov} onMonthChange={onMonthChange} onOpen={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: /previous month/i }))
  expect(onMonthChange).toHaveBeenCalled()
  const arg = onMonthChange.mock.calls[0][0] as Date
  expect(arg.getMonth()).toBe(9) // October
})

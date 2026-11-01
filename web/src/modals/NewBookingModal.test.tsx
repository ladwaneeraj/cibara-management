import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../api/bookings'
import { NewBookingModal } from './NewBookingModal'

vi.mock('../api/bookings')

afterEach(() => vi.resetAllMocks())

it('checks availability, lists free rooms, and books the chosen one', async () => {
  vi.mocked(api.checkAvailability).mockResolvedValue(['101', '102'])
  vi.mocked(api.createBooking).mockResolvedValue('new1')
  const onDone = vi.fn()
  render(<NewBookingModal initialDate="2026-11-10" onClose={() => {}} onDone={onDone} />)

  await userEvent.click(screen.getByRole('button', { name: /Check availability/i }))
  await userEvent.click(await screen.findByRole('button', { name: /Room 101/i }))

  await userEvent.type(screen.getByLabelText(/guest name/i), 'Asha')
  await userEvent.type(screen.getByLabelText(/mobile/i), '9811111111')
  await userEvent.type(screen.getByLabelText(/total amount/i), '1200')
  await userEvent.click(screen.getByRole('button', { name: /Create booking/i }))

  await waitFor(() => expect(onDone).toHaveBeenCalled())
  expect(api.createBooking).toHaveBeenCalledTimes(1)
  expect(api.createBooking).toHaveBeenCalledWith(
    expect.objectContaining({ room: '101', check_in_date: '2026-11-10', total_amount: 1200 }),
  )
})

it('warns when no rooms are available and offers none', async () => {
  vi.mocked(api.checkAvailability).mockResolvedValue([])
  render(<NewBookingModal initialDate="2026-11-10" onClose={() => {}} onDone={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: /Check availability/i }))
  expect(await screen.findByText(/no rooms available/i)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^Room /i })).not.toBeInTheDocument()
})

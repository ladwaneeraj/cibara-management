import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../api/bookings'
import { MultiBookingModal } from './MultiBookingModal'

vi.mock('../api/bookings')

afterEach(() => vi.resetAllMocks())

it('creates a multi-room booking for two rooms', async () => {
  vi.mocked(api.createMultiBooking).mockResolvedValue({ group_booking_id: 'g', booking_ids: ['a', 'b'] })
  const onDone = vi.fn()
  render(<MultiBookingModal onClose={() => {}} onDone={onDone} />)

  const roomInputs = screen.getAllByLabelText(/room number/i)
  const nameInputs = screen.getAllByLabelText(/guest name/i)
  const mobileInputs = screen.getAllByLabelText(/mobile/i)
  const totalInputs = screen.getAllByLabelText(/total/i)
  expect(roomInputs).toHaveLength(2)

  await userEvent.type(roomInputs[0], '101')
  await userEvent.type(nameInputs[0], 'Asha')
  await userEvent.type(mobileInputs[0], '9811111111')
  await userEvent.type(totalInputs[0], '1000')
  await userEvent.type(roomInputs[1], '102')
  await userEvent.type(nameInputs[1], 'Bimal')
  await userEvent.type(mobileInputs[1], '9822222222')
  await userEvent.type(totalInputs[1], '1500')

  await userEvent.click(screen.getByRole('button', { name: /Create 2 bookings/i }))
  await waitFor(() => expect(onDone).toHaveBeenCalled())
  expect(api.createMultiBooking).toHaveBeenCalledTimes(1)
  const payload = vi.mocked(api.createMultiBooking).mock.calls[0][0]
  expect(payload.rooms).toHaveLength(2)
  expect(payload.rooms[0]).toMatchObject({ room: '101', guest_name: 'Asha', total_amount: 1000 })
})

it('does not offer OTA sources (backend rejects them in multi)', () => {
  render(<MultiBookingModal onClose={() => {}} onDone={() => {}} />)
  const select = screen.queryByLabelText(/booking source/i) as HTMLSelectElement | null
  if (select) {
    const values = Array.from(select.options).map((o) => o.value)
    expect(values).not.toContain('mmt')
    expect(values).not.toContain('agoda')
  }
})

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../api/bookings'
import type { Booking } from '../types/booking'
import { OtaSettlementsModal } from './OtaSettlementsModal'

vi.mock('../api/bookings')

const unsettled: Booking = {
  booking_id: 'b1', room: '201', guest_name: 'Asha', guest_mobile: '9',
  check_in_date: '2026-11-05', check_out_date: '2026-11-07',
  status: 'confirmed', booking_source: 'mmt',
  total_amount: 1000, paid_amount: 0, balance: 0, net_receivable: 900,
}

afterEach(() => vi.resetAllMocks())

it('lists unsettled OTA bookings and marks one settled', async () => {
  vi.mocked(api.getMmtUnsettled).mockResolvedValue([unsettled])
  vi.mocked(api.getOtaSettlements).mockResolvedValue([])
  vi.mocked(api.markOtaSettlement).mockResolvedValue()
  const onChanged = vi.fn()
  render(<OtaSettlementsModal onClose={() => {}} onChanged={onChanged} />)

  await screen.findByText(/Asha/)
  // amount pre-fills from net_receivable (900); mark with the default.
  expect(screen.getByLabelText(/settlement amount/i)).toHaveValue(900)
  await userEvent.click(screen.getByRole('button', { name: /Mark received/i }))

  await waitFor(() => expect(api.markOtaSettlement).toHaveBeenCalledTimes(1))
  expect(api.markOtaSettlement).toHaveBeenCalledWith(
    expect.objectContaining({ booking_id: 'b1', settlement_amount: 900 }),
  )
  expect(onChanged).toHaveBeenCalled()
})

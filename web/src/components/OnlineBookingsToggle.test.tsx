import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../api/webConfig'
import { OnlineBookingsToggle } from './OnlineBookingsToggle'

vi.mock('../api/webConfig')
const mockGet = vi.mocked(api.getWebConfig)
const mockSet = vi.mocked(api.setOnlineBookings)

function allow(perm = 'settings.update') {
  window.CibaraAuth = { hasPermission: (p: string) => p === perm }
}

afterEach(() => {
  vi.resetAllMocks()
  delete (window as unknown as { CibaraAuth?: unknown }).CibaraAuth
})

it('renders nothing without settings.update permission', () => {
  window.CibaraAuth = { hasPermission: () => false }
  mockGet.mockResolvedValue({ online_bookings_enabled: true })
  const { container } = render(<OnlineBookingsToggle />)
  expect(container).toBeEmptyDOMElement()
  expect(mockGet).not.toHaveBeenCalled()
})

it('reflects the loaded online_bookings_enabled flag', async () => {
  allow()
  mockGet.mockResolvedValue({ online_bookings_enabled: true })
  render(<OnlineBookingsToggle />)
  const sw = await screen.findByRole('switch', { name: /online bookings/i })
  await waitFor(() => expect(sw).toBeChecked())
})

it('turns online bookings on when toggled', async () => {
  allow()
  mockGet.mockResolvedValue({ online_bookings_enabled: false })
  mockSet.mockResolvedValue({ online_bookings_enabled: true })
  render(<OnlineBookingsToggle />)
  const sw = await screen.findByRole('switch', { name: /online bookings/i })
  await waitFor(() => expect(sw).not.toBeChecked())
  await userEvent.click(sw)
  expect(mockSet).toHaveBeenCalledWith(true)
  await waitFor(() => expect(sw).toBeChecked())
})

it('reverts the switch when the save fails', async () => {
  allow()
  mockGet.mockResolvedValue({ online_bookings_enabled: false })
  mockSet.mockRejectedValue(new Error('network'))
  render(<OnlineBookingsToggle />)
  const sw = await screen.findByRole('switch', { name: /online bookings/i })
  await waitFor(() => expect(sw).not.toBeChecked())
  await userEvent.click(sw)
  await waitFor(() => expect(sw).not.toBeChecked())
})

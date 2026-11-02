import { act, waitFor } from '@testing-library/react'
import { mount } from './main'
import * as api from './api/bookings'
import * as webApi from './api/webConfig'

vi.mock('./api/bookings')
vi.mock('./api/webConfig')

test('mount renders the Bookings app into the provided root', async () => {
  vi.mocked(api.getBookings).mockResolvedValue([])
  vi.mocked(webApi.getWebConfig).mockResolvedValue({ online_bookings_enabled: false })
  const root = document.createElement('div')
  document.body.appendChild(root)
  const reactRoot = mount(root)
  await waitFor(() => expect(root.textContent).toContain('Room Bookings'))
  // mount() owns its createRoot, which RTL does not auto-unmount; tear it down
  // inside act so the toolbar toggle's async load doesn't update after teardown.
  await act(async () => {
    reactRoot.unmount()
  })
})

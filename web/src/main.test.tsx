import { waitFor } from '@testing-library/react'
import { mount } from './main'
import * as api from './api/bookings'

vi.mock('./api/bookings')

test('mount renders the Bookings app into the provided root', async () => {
  vi.mocked(api.getBookings).mockResolvedValue([])
  const root = document.createElement('div')
  document.body.appendChild(root)
  mount(root)
  await waitFor(() => expect(root.textContent).toContain('Room Bookings'))
})

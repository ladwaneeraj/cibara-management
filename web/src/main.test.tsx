import { waitFor } from '@testing-library/react'
import { mount } from './main'

test('mount renders the island into the provided root', async () => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  mount(root)
  await waitFor(() =>
    expect(root.querySelector('[data-testid="bookings-island"]')).not.toBeNull(),
  )
})

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Mount the Bookings island into a host element. Exported so tests can mount
// into an arbitrary root; in production it auto-mounts into the
// #bookings-react-root div inside the classic templates/index.html.
export function mount(root: HTMLElement): void {
  createRoot(root).render(
    <StrictMode>
      <div data-testid="bookings-island">Bookings island</div>
    </StrictMode>,
  )
}

const host =
  typeof document !== 'undefined'
    ? document.getElementById('bookings-react-root')
    : null
if (host) mount(host)

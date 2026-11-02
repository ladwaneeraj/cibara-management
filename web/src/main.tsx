import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import './theme/island.css'
import { BookingsApp } from './BookingsApp'

// Mount the Bookings island into a host element. Returns the React root so
// callers (tests) can unmount it; in production it auto-mounts into the
// #bookings-react-root div inside the classic templates/index.html.
export function mount(root: HTMLElement): Root {
  const r = createRoot(root)
  r.render(
    <StrictMode>
      <BookingsApp />
    </StrictMode>,
  )
  return r
}

const host =
  typeof document !== 'undefined'
    ? document.getElementById('bookings-react-root')
    : null
if (host) mount(host)

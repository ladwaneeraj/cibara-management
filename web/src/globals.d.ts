// Globals provided by the classic UI runtime (static/auth.js etc.) that the
// island reads, plus the compatibility globals the island itself installs
// for room-calendar.js (see src/bridge.ts).
export {}

declare global {
  interface Window {
    /** Authenticated fetch wrapper from static/auth.js (JWT + refresh + duplicate guard). */
    apiFetch?: typeof fetch
    /** Role/permission helpers from static/auth.js. */
    CibaraAuth?: {
      currentUser?: () => { role?: string } | null
      hasPermission?: (perm: string) => boolean
      ready?: () => Promise<unknown>
    }
    /** Legacy Room-blocks modal opener (static/script.js). */
    openBlocksModal?: () => void
    /** Compat globals the island installs for room-calendar.js. */
    fetchBookings?: () => Promise<void>
    showBookingDetails?: (bookingId: string) => void
    showNewBookingModalForDate?: (dateStr: string) => void
  }
}

// Compatibility bridge: the island installs the three globals that
// room-calendar.js calls (guarded by `typeof … === "function"`), so the
// Rooms-tab calendar keeps working once booking.js stops defining them.
// The island's app registers a controller; the globals forward to it.

export interface BridgeController {
  refresh: () => Promise<void> | void
  openDrawer: (bookingId: string) => void
  openNewBooking: (opts?: { date?: string }) => void
}

let current: BridgeController | null = null

export function installBridge(controller: BridgeController): void {
  current = controller
  window.fetchBookings = async () => {
    await current?.refresh()
  }
  window.showBookingDetails = (bookingId: string) => current?.openDrawer(bookingId)
  window.showNewBookingModalForDate = (dateStr: string) =>
    current?.openNewBooking({ date: dateStr })
}

export function uninstallBridge(): void {
  current = null
  delete window.fetchBookings
  delete window.showBookingDetails
  delete window.showNewBookingModalForDate
}

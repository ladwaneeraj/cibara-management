// Deep link: /legacy#...?booking=<id> opens that booking's drawer on load.
export function getDeepLinkBookingId(search: string): string | null {
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    return params.get('booking')
  } catch {
    return null
  }
}

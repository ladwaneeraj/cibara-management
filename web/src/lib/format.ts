// Display formatters. formatTime/formatDate mirror static/booking.js exactly
// (lines 1531-1552) so the island reads identically to the classic UI.

export function formatTime(timeStr?: string): string {
  if (!timeStr) return '2:00 PM' // booking.js default display
  const [hours, minutes] = timeStr.split(':')
  const hour = parseInt(hours, 10)
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const displayHour = hour % 12 || 12
  return `${displayHour}:${minutes} ${ampm}`
}

export function formatDate(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return typeof date === 'string' ? date : ''
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function formatMoney(amount: number): string {
  const n = Math.round(Number(amount) || 0)
  return '₹' + n.toLocaleString('en-IN')
}

export function nights(checkIn: string, checkOut: string): number {
  const a = new Date(checkIn)
  const b = new Date(checkOut)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0
  return Math.max(Math.round((b.getTime() - a.getTime()) / 86_400_000), 0)
}

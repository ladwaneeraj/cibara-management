// Reservation timeline model: per-room lanes of booking spans over a date
// window, with overbooking (same-room date overlap) flagged. Overlap uses the
// half-open [check-in, check-out) convention, so back-to-back stays (one's
// checkout == the next's check-in) do NOT conflict.
import type { Booking } from '../types/booking'
import { formatDateForAPI } from './calendar'

export interface TimelineSpan {
  booking: Booking
  startIndex: number // column offset from the window start (clamped to 0)
  length: number // columns covered within the window (>= 1)
  conflict: boolean
}
export interface TimelineLane {
  room: string
  spans: TimelineSpan[]
}
export interface Timeline {
  dates: string[]
  lanes: TimelineLane[]
}

function dayNumber(iso: string): number {
  const d = new Date(iso)
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 86_400_000)
}

function overlaps(a: Booking, b: Booking): boolean {
  return dayNumber(a.check_in_date) < dayNumber(b.check_out_date) &&
    dayNumber(b.check_in_date) < dayNumber(a.check_out_date)
}

export function buildTimeline(
  bookings: Booking[],
  rooms: string[] | null,
  rangeStart: Date,
  days: number,
): Timeline {
  const start = new Date(rangeStart)
  start.setHours(0, 0, 0, 0)
  const startDay = Math.floor(start.getTime() / 86_400_000)
  const endDay = startDay + days

  const dates: string[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    dates.push(formatDateForAPI(d))
  }

  const active = bookings.filter((b) => b.status !== 'cancelled')
  const roomList =
    rooms && rooms.length
      ? rooms
      : Array.from(new Set(active.map((b) => String(b.room)))).sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true }),
        )

  const lanes: TimelineLane[] = roomList.map((room) => {
    const roomBookings = active.filter((b) => String(b.room) === room)
    const spans: TimelineSpan[] = []
    for (const booking of roomBookings) {
      const ci = dayNumber(booking.check_in_date)
      const co = dayNumber(booking.check_out_date)
      if (co <= startDay || ci >= endDay) continue // outside the window
      const startIndex = Math.max(ci - startDay, 0)
      const endIndex = Math.min(co - startDay, days) // exclusive (checkout day not occupied)
      const length = Math.max(endIndex - startIndex, 1)
      const conflict = roomBookings.some((other) => other !== booking && overlaps(booking, other))
      spans.push({ booking, startIndex, length, conflict })
    }
    spans.sort((a, b) => a.startIndex - b.startIndex)
    return { room, spans }
  })

  return { dates, lanes }
}

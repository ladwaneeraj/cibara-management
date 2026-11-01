// Month-grid helpers, parity with booking.js renderCalendar / createDayElement
// / isDateInBookingRange / getCurrentMonthBookings (booking.js:3495-3966).
import type { Booking } from '../types/booking'

export function formatDateForAPI(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// A date is in the stay if it's on/after check-in and BEFORE check-out — the
// checkout day itself is not part of the stay (booking.js:3943-3958).
export function isDateInBookingRange(
  dateStr: string,
  checkInDate: string,
  checkOutDate: string,
): boolean {
  const date = new Date(dateStr)
  const checkIn = new Date(checkInDate)
  const checkOut = new Date(checkOutDate)
  date.setHours(0, 0, 0, 0)
  checkIn.setHours(0, 0, 0, 0)
  checkOut.setHours(0, 0, 0, 0)
  return date >= checkIn && date < checkOut
}

export interface DayCell {
  day: number
  dateStr: string
  inMonth: boolean
  isToday: boolean
  bookings: Booking[] // active (non-cancelled) bookings occupying this day
}

export function buildMonthGrid(viewDate: Date, bookings: Booking[], today: Date = new Date()): DayCell[] {
  const year = viewDate.getFullYear()
  const month = viewDate.getMonth()
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)
  const startingDay = firstDay.getDay()
  const prevMonthLastDay = new Date(year, month, 0).getDate()
  const active = bookings.filter((b) => b.status !== 'cancelled')
  const todayStr = formatDateForAPI(today)
  const cells: DayCell[] = []

  const push = (day: number, d: Date, inMonth: boolean) => {
    const dateStr = formatDateForAPI(d)
    cells.push({
      day,
      dateStr,
      inMonth,
      isToday: dateStr === todayStr,
      bookings: active.filter((b) =>
        isDateInBookingRange(dateStr, b.check_in_date, b.check_out_date),
      ),
    })
  }

  for (let i = 0; i < startingDay; i++) {
    const day = prevMonthLastDay - startingDay + i + 1
    push(day, new Date(year, month - 1, day), false)
  }
  for (let day = 1; day <= lastDay.getDate(); day++) {
    push(day, new Date(year, month, day), true)
  }
  const total = startingDay + lastDay.getDate()
  const remaining = 7 - (total % 7)
  if (remaining < 7) {
    for (let day = 1; day <= remaining; day++) {
      push(day, new Date(year, month + 1, day), false)
    }
  }
  return cells
}

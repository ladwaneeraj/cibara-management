// Month calendar, parity with the classic booking.js calendar. Reuses the
// classic calendar CSS classes so it matches the ERP. Clicking a day shows
// that day's bookings below the grid; clicking one opens the drawer.
import { useMemo, useState, type KeyboardEvent } from 'react'
import type { Booking } from '../types/booking'
import { buildMonthGrid } from '../lib/calendar'
import { formatDate } from '../lib/format'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export interface CalendarViewProps {
  bookings: Booking[]
  month: Date
  onMonthChange: (next: Date) => void
  onOpen: (bookingId: string) => void
}

export function CalendarView({ bookings, month, onMonthChange, onOpen }: CalendarViewProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const cells = useMemo(() => buildMonthGrid(month, bookings), [month, bookings])
  const title = `${MONTHS[month.getMonth()]} ${month.getFullYear()}`
  const step = (delta: number) => onMonthChange(new Date(month.getFullYear(), month.getMonth() + delta, 1))
  const selectedCell = cells.find((c) => c.dateStr === selected)

  const pick = (dateStr: string) => () => setSelected(dateStr)
  const onKey = (dateStr: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setSelected(dateStr)
    }
  }

  return (
    <div className="bookings-calendar-container">
      <div className="calendar-header">
        <button className="calendar-nav-btn" type="button" onClick={() => step(-1)} aria-label="Previous month">
          <i className="fas fa-chevron-left" aria-hidden="true" />
        </button>
        <h3 className="calendar-title" id="calendar-title">{title}</h3>
        <button className="calendar-nav-btn" type="button" onClick={() => step(1)} aria-label="Next month">
          <i className="fas fa-chevron-right" aria-hidden="true" />
        </button>
      </div>

      <div className="calendar-controls">
        <button className="action-btn btn-sm" type="button" onClick={() => onMonthChange(new Date())}>
          Today
        </button>
        <div className="calendar-legend">
          <span className="legend-item"><span className="legend-color confirmed" /> Confirmed</span>
          <span className="legend-item"><span className="legend-color checked-in" /> Checked In</span>
        </div>
      </div>

      <div className="calendar-weekdays">
        {WEEKDAYS.map((w) => (
          <div key={w} className="calendar-weekday">{w}</div>
        ))}
      </div>

      <div className="calendar-days-grid" id="calendar-days-grid">
        {cells.map((c, i) => {
          const confirmed = c.bookings.some((b) => b.status === 'confirmed')
          const checkedIn = c.bookings.some((b) => b.status === 'checked_in')
          const cls = [
            'calendar-day',
            c.inMonth ? '' : 'different-month',
            c.isToday ? 'today' : '',
            confirmed ? 'has-bookings' : '',
            checkedIn ? 'has-checkins' : '',
          ].filter(Boolean).join(' ')
          return (
            <div
              key={i}
              className={cls}
              data-date={c.dateStr}
              role="button"
              tabIndex={0}
              onClick={pick(c.dateStr)}
              onKeyDown={onKey(c.dateStr)}
            >
              <div className="day-number">{c.day}</div>
              {c.bookings.length > 0 ? (
                <div className={`booking-count ${c.bookings.length > 1 ? 'has-multiple' : ''}`}>
                  {c.bookings.length} booking{c.bookings.length !== 1 ? 's' : ''}
                </div>
              ) : null}
              {c.bookings.slice(0, 2).map((b) => (
                <div
                  key={b.booking_id}
                  className={`day-booking-preview ${b.status === 'checked_in' ? 'checked-in' : ''}`}
                >
                  {b.room}: {b.guest_name}
                </div>
              ))}
              {c.bookings.length > 2 ? (
                <div className="day-booking-preview more-indicator">+{c.bookings.length - 2} more</div>
              ) : null}
            </div>
          )
        })}
      </div>

      {selectedCell ? (
        <div className="bki-day-details">
          <h4>{formatDate(selectedCell.dateStr)}</h4>
          {selectedCell.bookings.length === 0 ? (
            <p className="bki-empty">No bookings</p>
          ) : (
            selectedCell.bookings.map((b) => (
              <button
                key={b.booking_id}
                type="button"
                className="bki-day-booking"
                onClick={() => onOpen(b.booking_id)}
              >
                Room {b.room} · {b.guest_name}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

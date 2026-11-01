// Reservation timeline: rooms (rows) × dates (columns), booking bars placed by
// CSS grid, overbooking conflicts highlighted. A date header cell opens a new
// booking for that date; a bar opens the drawer. Horizontally scrollable.
import { useMemo, useState } from 'react'
import type { Booking } from '../types/booking'
import { buildTimeline } from '../lib/timeline'

const DEFAULT_DAYS = 14

export interface TimelineViewProps {
  bookings: Booking[]
  rooms?: string[]
  rangeStart?: Date
  days?: number
  onOpen: (bookingId: string) => void
  onNewForDate: (dateStr: string) => void
}

export function TimelineView({
  bookings,
  rooms,
  rangeStart,
  days = DEFAULT_DAYS,
  onOpen,
  onNewForDate,
}: TimelineViewProps) {
  const [start, setStart] = useState<Date>(() => {
    const d = rangeStart ? new Date(rangeStart) : new Date()
    d.setHours(0, 0, 0, 0)
    return d
  })
  const { dates, lanes } = useMemo(
    () => buildTimeline(bookings, rooms ?? null, start, days),
    [bookings, rooms, start, days],
  )
  const hasConflict = lanes.some((l) => l.spans.some((s) => s.conflict))
  const shift = (delta: number) => {
    const d = new Date(start)
    d.setDate(d.getDate() + delta)
    setStart(d)
  }
  const cols = `120px repeat(${days}, minmax(44px, 1fr))`

  return (
    <div className="bki-timeline">
      <div className="calendar-header">
        <button className="calendar-nav-btn" type="button" onClick={() => shift(-7)} aria-label="Earlier">
          <i className="fas fa-chevron-left" aria-hidden="true" />
        </button>
        <span className="bki-timeline-range">
          {dates[0]} → {dates[dates.length - 1]}
        </span>
        <button className="calendar-nav-btn" type="button" onClick={() => shift(7)} aria-label="Later">
          <i className="fas fa-chevron-right" aria-hidden="true" />
        </button>
      </div>

      {hasConflict ? (
        <div className="bki-error" role="alert">
          ⚠ Overbooking detected — two bookings overlap on the same room.
        </div>
      ) : null}

      <div className="bki-timeline-scroll">
        <div className="bki-timeline-grid" style={{ gridTemplateColumns: cols }}>
          <div className="bki-tl-corner" />
          {dates.map((d) => (
            <button
              key={d}
              type="button"
              className="bki-tl-date"
              onClick={() => onNewForDate(d)}
              title={`New booking on ${d}`}
            >
              {d.slice(8)}
            </button>
          ))}

          {lanes.map((lane) => (
            <TimelineRow key={lane.room} room={lane.room} spans={lane.spans} days={days} onOpen={onOpen} />
          ))}
        </div>
      </div>
    </div>
  )
}

function TimelineRow({
  room,
  spans,
  days,
  onOpen,
}: {
  room: string
  spans: import('../lib/timeline').TimelineSpan[]
  days: number
  onOpen: (bookingId: string) => void
}) {
  return (
    <>
      <div className="bki-tl-room">Room {room}</div>
      <div className="bki-tl-lane" style={{ gridColumn: `2 / span ${days}`, gridTemplateColumns: `repeat(${days}, minmax(44px, 1fr))` }}>
        {spans.map((s) => (
          <button
            key={s.booking.booking_id}
            type="button"
            className={`bki-tl-bar ${s.conflict ? 'conflict' : ''}`}
            style={{ gridColumn: `${s.startIndex + 1} / span ${s.length}` }}
            onClick={() => onOpen(s.booking.booking_id)}
            title={`${s.booking.guest_name} (Room ${room})`}
          >
            {s.booking.guest_name}
          </button>
        ))}
      </div>
    </>
  )
}

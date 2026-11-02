// Booking list card (island redesign). A denser, clearer card with a coloured
// left status rail, a prominent guest name, an icon stay-line and a footer that
// pairs the payment state with the amount. Island-scoped .bki-card-* classes
// (see island.css) own the layout; the status/source chips keep the classic
// ERP badge classes so they read the same as the rest of the app. The whole
// card is the tap target (role=button + Enter/Space) and opens the drawer.
import type { KeyboardEvent } from 'react'
import type { Booking } from '../types/booking'
import { statusLabel } from '../theme/tokens'
import { formatDate, formatTime, nights } from '../lib/format'
import { bookingBalance, isOtaPrepaid, otaSourceLabel, paymentLabel } from '../lib/booking'

const STATUS_CLASS: Record<string, string> = {
  confirmed: 'confirmed',
  cancelled: 'cancelled',
  checked_in: 'checked-in',
  checked_out: 'checked-out',
  no_show: 'no-show',
}

const PAYMENT_TEXT = { paid: 'Fully Paid', partial: 'Partially Paid', unpaid: 'Unpaid' } as const

export interface BookingCardProps {
  booking: Booking
  groupSize?: number
  isRepeat?: boolean
  onOpen: (bookingId: string) => void
}

export function BookingCard({ booking, groupSize = 0, isRepeat = false, onOpen }: BookingCardProps) {
  const src = booking.booking_source || 'normal'
  const ota = isOtaPrepaid(src)
  const n = nights(booking.check_in_date, booking.check_out_date)
  const today = new Date().toISOString().slice(0, 10)
  const isToday = new Date(booking.check_in_date).toISOString().slice(0, 10) === today
  const balance = bookingBalance(booking)
  const pay = paymentLabel(booking)

  const open = () => onOpen(booking.booking_id)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open()
    }
  }

  return (
    <div
      className="bki-card"
      data-status={booking.status}
      data-id={booking.booking_id}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKey}
    >
      <span className="bki-card-rail" aria-hidden="true" />
      <div className="bki-card-main">
        <div className="bki-card-top">
          <span className="bki-card-room">
            Room {booking.room}
            {booking.is_ac ? <span className="bki-card-ac" title="AC room">❄️</span> : null}
          </span>
          <span className="bki-card-badges">
            <span className={`status-badge ${STATUS_CLASS[booking.status] ?? ''}`}>
              {statusLabel[booking.status] ?? 'Unknown'}
            </span>
            {isToday ? <span className="today-badge">Today</span> : null}
            {isRepeat ? <span className="bk-group-chip" title="Returning guest">★ Repeat</span> : null}
            {groupSize > 1 ? (
              <span className="bk-group-chip">
                <i className="fas fa-layer-group" aria-hidden="true" /> Group · {groupSize}
              </span>
            ) : null}
            {ota ? (
              <span className={`booking-source-badge src-${src}`}>
                <i className="fas fa-globe" aria-hidden="true" /> {otaSourceLabel(src)}
              </span>
            ) : null}
          </span>
        </div>

        <div className="bki-card-guest">{booking.guest_name}</div>

        <div className="bki-card-stay">
          <span className="bki-card-stay-dates">
            <i className="fas fa-calendar-check" aria-hidden="true" /> {formatDate(booking.check_in_date)}
            <span className="bki-card-arrow">→</span> {formatDate(booking.check_out_date)}
          </span>
          <span className="bki-card-dot">·</span>
          <span>{n} night{n !== 1 ? 's' : ''}</span>
          <span className="bki-card-time">
            <i className="fas fa-clock" aria-hidden="true" /> {formatTime(booking.check_in_time)}
          </span>
        </div>

        <div className="bki-card-foot">
          <span className="bki-card-pay">
            <span className={`payment-badge ${pay}`}>{PAYMENT_TEXT[pay]}</span>
            {!ota && balance > 0 ? <span className="bki-card-due">₹{balance} due</span> : null}
          </span>
          <span className="bki-card-amount">{ota ? 'OTA' : '₹' + booking.total_amount}</span>
        </div>
      </div>
    </div>
  )
}

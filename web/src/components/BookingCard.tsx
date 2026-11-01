// Booking list card. Reuses the classic booking.css classes (.booking-item,
// .status-badge, .booking-source-badge, …) so it is visually identical to the
// classic UI. Structure mirrors booking.js:1455-1483. The whole card is the
// tap target (role=button + Enter/Space), opening the detail drawer.
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

  let stateClass = ''
  if (booking.status === 'cancelled') stateClass = 'bk-cancelled'
  else if (booking.status === 'checked_in') stateClass = 'bk-checked-in'
  else if (isToday) stateClass = 'bk-arriving-today'

  const open = () => onOpen(booking.booking_id)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open()
    }
  }

  return (
    <div
      className={`booking-item ${stateClass}`}
      data-id={booking.booking_id}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKey}
    >
      <div className="booking-header">
        <div className="booking-room">
          Room {booking.room}
          {booking.is_ac ? <span style={{ fontSize: '0.7rem', color: '#0ea5e9' }}> ❄️</span> : null}
        </div>
        <div className="booking-badges">
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
          {booking.is_ac ? (
            <span
              className="booking-source-badge"
              style={{
                background: 'linear-gradient(135deg,#e0f2fe,#bae6fd)',
                color: '#0369a1',
                border: '1px solid #7dd3fc',
              }}
            >
              ❄️ AC
            </span>
          ) : null}
          {ota ? (
            <span className={`booking-source-badge src-${src}`}>
              <i className="fas fa-globe" aria-hidden="true" /> {otaSourceLabel(src)}
            </span>
          ) : null}
        </div>
      </div>
      <div className="booking-guest">{booking.guest_name}</div>
      <div className="bk-stay-line">
        <i className="fas fa-calendar-check" aria-hidden="true" /> {formatDate(booking.check_in_date)}
        <span className="bk-stay-sep">→</span> {formatDate(booking.check_out_date)}
        <span className="bk-stay-sep">·</span> {n} night{n !== 1 ? 's' : ''}
        <span className="bk-stay-time">
          <i className="fas fa-clock" aria-hidden="true" /> {formatTime(booking.check_in_time)}
        </span>
      </div>
      <div className="booking-footer">
        <div className="booking-payment">
          <span className={`payment-badge ${pay}`}>{PAYMENT_TEXT[pay]}</span>
          {!ota && balance > 0 ? <span className="bk-balance-note">₹{balance} due</span> : null}
        </div>
        <div className="booking-amount">{ota ? 'OTA' : '₹' + booking.total_amount}</div>
      </div>
    </div>
  )
}

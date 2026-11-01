// Booking detail side-drawer (replaces the classic details modal). Portaled to
// <body> so it works from any tab, including the Rooms-grid calendar via the
// bridge. Shows the booking + payment summary and the quick actions.
import { createPortal } from 'react-dom'
import type { Booking } from '../types/booking'
import { statusLabel } from '../theme/tokens'
import { formatDate, formatMoney, formatTime, nights } from '../lib/format'
import { bookingBalance, isOtaPrepaid, otaSourceLabel } from '../lib/booking'
import { QuickActions, type BookingAction } from './QuickActions'

export interface BookingDrawerProps {
  booking: Booking | null
  members?: Booking[]
  onAction: (action: BookingAction, booking: Booking) => void
  onGroupCheckin?: () => void
  groupBusy?: boolean
  onClose: () => void
}

export function BookingDrawer({
  booking,
  members = [],
  onAction,
  onGroupCheckin,
  groupBusy,
  onClose,
}: BookingDrawerProps) {
  if (!booking) return null
  const isGroup = members.length > 1
  const anyConfirmed = members.some((m) => m.status === 'confirmed')
  const balance = bookingBalance(booking)
  const n = nights(booking.check_in_date, booking.check_out_date)
  const ota = isOtaPrepaid(booking.booking_source)

  return createPortal(
    <div className="bki-portal">
      <div className="bki-drawer-backdrop" onClick={onClose} />
      <aside className="bki-drawer" role="dialog" aria-label="Booking details" aria-modal="true">
        <header className="bki-drawer-head">
          <h3>
            Room {booking.room} · <span className="bki-drawer-guest">{booking.guest_name}</span>
          </h3>
          <button type="button" className="bki-drawer-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="bki-drawer-body">
          <div className="bki-drawer-row">
            <span className={`status-badge ${booking.status}`}>{statusLabel[booking.status] ?? booking.status}</span>
            {ota ? <span className="booking-source-badge">{otaSourceLabel(booking.booking_source)}</span> : null}
            {booking.group_booking_id ? <span className="bk-group-chip">Group</span> : null}
          </div>
          <dl className="bki-drawer-dl">
            <dt>Stay</dt>
            <dd>
              {formatDate(booking.check_in_date)} → {formatDate(booking.check_out_date)} · {n} night
              {n !== 1 ? 's' : ''} · {formatTime(booking.check_in_time)}
            </dd>
            <dt>Guest</dt>
            <dd>
              {booking.guest_name} · {booking.guest_mobile}
              {booking.guest_count ? ` · ${booking.guest_count} guest(s)` : ''}
            </dd>
            <dt>Payment</dt>
            <dd>
              Total {ota ? 'OTA' : formatMoney(booking.total_amount)} · Paid {formatMoney(booking.paid_amount)} ·{' '}
              <strong>Balance {formatMoney(balance)}</strong>
            </dd>
            {booking.notes ? (
              <>
                <dt>Notes</dt>
                <dd>{booking.notes}</dd>
              </>
            ) : null}
          </dl>
          {isGroup ? (
            <div className="bki-group">
              <h4>Group · {members.length} rooms</h4>
              <ul className="bki-group-list">
                {members.map((m) => (
                  <li key={m.booking_id}>
                    Room {m.room} · {m.guest_name} · {statusLabel[m.status] ?? m.status}
                  </li>
                ))}
              </ul>
              {anyConfirmed && onGroupCheckin ? (
                <button
                  type="button"
                  className="action-btn btn-sm btn-primary"
                  onClick={onGroupCheckin}
                  disabled={groupBusy}
                >
                  {groupBusy ? 'Checking in…' : 'Group check-in'}
                </button>
              ) : null}
            </div>
          ) : null}
          <QuickActions booking={booking} onAction={(a) => onAction(a, booking)} />
        </div>
      </aside>
    </div>,
    document.body,
  )
}

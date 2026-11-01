import type { Booking } from '../types/booking'
import { bookingBalance, isOtaPrepaid } from '../lib/booking'

export type BookingAction = 'convert' | 'cancel' | 'collect' | 'whatsapp' | 'edit'

export interface QuickActionsProps {
  booking: Booking
  onAction: (action: BookingAction) => void
}

export function QuickActions({ booking, onAction }: QuickActionsProps) {
  const ota = isOtaPrepaid(booking.booking_source)
  const balance = bookingBalance(booking)
  const canCollect = !ota && balance > 0 && booking.status !== 'cancelled'
  const live = booking.status !== 'cancelled' && booking.status !== 'checked_out'

  const Btn = ({ action, label, cls }: { action: BookingAction; label: string; cls?: string }) => (
    <button type="button" className={`action-btn btn-sm ${cls ?? ''}`} onClick={() => onAction(action)}>
      {label}
    </button>
  )

  return (
    <div className="bki-actions bki-row">
      {booking.status === 'confirmed' ? <Btn action="convert" label="Check-in" cls="btn-primary" /> : null}
      {canCollect ? <Btn action="collect" label="Collect payment" /> : null}
      {booking.status === 'confirmed' ? <Btn action="cancel" label="Cancel" cls="bk-tool-slate" /> : null}
      {booking.guest_mobile ? <Btn action="whatsapp" label="WhatsApp" /> : null}
      {live ? <Btn action="edit" label="Edit" /> : null}
    </div>
  )
}

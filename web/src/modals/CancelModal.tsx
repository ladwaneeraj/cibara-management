import { useState } from 'react'
import type { Booking, PaymentMethod } from '../types/booking'
import { cancelBooking } from '../api/bookings'
import { formatMoney } from '../lib/format'
import { Modal } from '../components/Modal'
import { PaymentMethodPicker } from '../components/PaymentMethodPicker'

// Cancel a booking → cancel_booking (routes/bookings.py:690-838). Client mirror
// of the server guard (refund ≤ paid). retain_as_charge mints a cancellation
// invoice (SAC 999794/18%); the returned bill number is surfaced.
export function CancelModal({
  booking,
  onClose,
  onDone,
}: {
  booking: Booking
  onClose: () => void
  onDone: () => void
}) {
  const paid = booking.paid_amount || 0
  const [refund, setRefund] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [reason, setReason] = useState('')
  const [retain, setRetain] = useState(paid > 0) // booking.js default: pre-tick when paid
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chargeBill, setChargeBill] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const refundAmt = parseInt(refund || '0', 10) || 0
    if (refundAmt > paid) {
      setError(`Refund amount cannot exceed the paid amount (${formatMoney(paid)})`)
      return
    }
    setPending(true)
    setError(null)
    try {
      const res = await cancelBooking({
        booking_id: booking.booking_id,
        refund_amount: refundAmt,
        refund_method: method,
        reason,
        retain_as_charge: retain,
      })
      setDone(true)
      setChargeBill(res.charge_bill_number ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancellation failed')
    } finally {
      setPending(false)
    }
  }

  if (done) {
    return (
      <Modal title="Booking cancelled" onClose={onDone}>
        <p>Booking cancelled.</p>
        {chargeBill ? (
          <p>
            Cancellation invoice <strong>{chargeBill}</strong> issued (SAC 999794 / 18%).
          </p>
        ) : null}
        <button type="button" className="action-btn btn-primary" onClick={onDone}>
          Done
        </button>
      </Modal>
    )
  }

  return (
    <Modal title={`Cancel booking — Room ${booking.room}`} onClose={onClose}>
      <form onSubmit={submit} className="bki-form">
        <p>Paid so far: {formatMoney(paid)}</p>
        <label className="bki-field">
          Refund amount
          <input
            type="number"
            min="0"
            value={refund}
            onChange={(e) => setRefund(e.target.value)}
            aria-label="Refund amount"
            placeholder="0"
          />
        </label>
        <PaymentMethodPicker value={method} onChange={setMethod} />
        <label className="bki-field">
          Reason
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
        </label>
        <label className="bki-check">
          <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} />
          Keep retained amount as a cancellation charge (issues a tax invoice)
        </label>
        {error ? <div className="bki-error" role="alert">{error}</div> : null}
        <button type="submit" className="action-btn btn-primary" disabled={pending}>
          {pending ? 'Processing…' : 'Confirm cancellation'}
        </button>
      </form>
    </Modal>
  )
}

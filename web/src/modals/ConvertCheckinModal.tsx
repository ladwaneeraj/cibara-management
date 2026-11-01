import { useState } from 'react'
import type { Booking, PaymentMethod } from '../types/booking'
import { convertToCheckin } from '../api/bookings'
import { isOtaPrepaid } from '../lib/booking'
import { formatMoney } from '../lib/format'
import { Modal } from '../components/Modal'
import { PaymentMethodPicker } from '../components/PaymentMethodPicker'

// Convert a booking to a check-in → convert_booking_to_checkin
// (routes/bookings.py:844). Mirrors the server guard: 'balance' (Pay Later)
// cannot be combined with an amount. OTA prepaid bookings collect nothing.
export function ConvertCheckinModal({
  booking,
  onClose,
  onDone,
}: {
  booking: Booking
  onClose: () => void
  onDone: () => void
}) {
  const ota = isOtaPrepaid(booking.booking_source)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>(ota ? 'ota' : 'cash')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const amt = ota ? 0 : parseInt(amount || '0', 10) || 0
    if (method === 'balance' && amt > 0) {
      setError("Can't use 'Pay Later' with an amount paid. Choose Cash or Online.")
      return
    }
    setPending(true)
    setError(null)
    try {
      await convertToCheckin({
        booking_id: booking.booking_id,
        remaining_payment: amt,
        payment_method: method,
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check-in failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal title={`Check in — Room ${booking.room}`} onClose={onClose}>
      <form onSubmit={submit} className="bki-form">
        {ota ? (
          <p className="bki-note">OTA prepaid — nothing to collect; settlement arrives from the OTA.</p>
        ) : (
          <>
            <p>Balance: {formatMoney(booking.balance)}</p>
            <label className="bki-field">
              Amount collected now
              <input
                type="number"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-label="Amount"
                placeholder="0"
              />
            </label>
            <PaymentMethodPicker value={method} onChange={setMethod} includeLater />
          </>
        )}
        {error ? <div className="bki-error" role="alert">{error}</div> : null}
        <button type="submit" className="action-btn btn-primary" disabled={pending}>
          {pending ? 'Processing…' : 'Check in'}
        </button>
      </form>
    </Modal>
  )
}

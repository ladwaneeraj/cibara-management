import { useState } from 'react'
import type { Booking, PaymentMethod } from '../types/booking'
import { updateBooking } from '../api/bookings'
import { bookingBalance } from '../lib/booking'
import { formatMoney } from '../lib/format'
import { Modal } from '../components/Modal'
import { PaymentMethodPicker } from '../components/PaymentMethodPicker'

// Collect an additional payment against a booking → update_booking with a
// new_payment (routes/bookings.py:609-688). One apiFetch call, button disabled
// while in flight (no double submit).
export function PaymentModal({
  booking,
  onClose,
  onDone,
}: {
  booking: Booking
  onClose: () => void
  onDone: () => void
}) {
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const amt = parseInt(amount || '0', 10) || 0
    if (amt <= 0) {
      setError('Enter an amount greater than zero')
      return
    }
    setPending(true)
    setError(null)
    try {
      await updateBooking({ booking_id: booking.booking_id, new_payment: amt, payment_method: method })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal title={`Collect payment — Room ${booking.room}`} onClose={onClose}>
      <form onSubmit={submit} className="bki-form">
        <p>Balance due: {formatMoney(bookingBalance(booking))}</p>
        <label className="bki-field">
          Amount
          <input
            type="number"
            min="1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Amount"
            placeholder="Amount"
          />
        </label>
        <PaymentMethodPicker value={method} onChange={setMethod} />
        {error ? <div className="bki-error" role="alert">{error}</div> : null}
        <button type="submit" className="action-btn btn-primary" disabled={pending}>
          {pending ? 'Processing…' : 'Collect'}
        </button>
      </form>
    </Modal>
  )
}

import { useState } from 'react'
import type { Booking, UpdateBookingPayload } from '../types/booking'
import { updateBooking } from '../api/bookings'
import { Modal } from '../components/Modal'

// Edit a booking's details → update_booking (routes/bookings.py:609-688,
// updatable_fields). Sends the editable fields; the server recomputes balance.
export function UpdateBookingModal({
  booking,
  onClose,
  onDone,
}: {
  booking: Booking
  onClose: () => void
  onDone: () => void
}) {
  const [form, setForm] = useState({
    guest_name: booking.guest_name ?? '',
    guest_mobile: booking.guest_mobile ?? '',
    check_in_date: booking.check_in_date ?? '',
    check_in_time: booking.check_in_time ?? '',
    check_out_date: booking.check_out_date ?? '',
    room: booking.room ?? '',
    guest_count: String(booking.guest_count ?? 1),
    total_amount: String(booking.total_amount ?? 0),
    notes: booking.notes ?? '',
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    const payload: UpdateBookingPayload = {
      booking_id: booking.booking_id,
      guest_name: form.guest_name,
      guest_mobile: form.guest_mobile,
      check_in_date: form.check_in_date,
      check_in_time: form.check_in_time,
      check_out_date: form.check_out_date,
      room: form.room,
      guest_count: parseInt(form.guest_count || '1', 10) || 1,
      total_amount: parseInt(form.total_amount || '0', 10) || 0,
      notes: form.notes,
    }
    try {
      await updateBooking(payload)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal title={`Edit booking — Room ${booking.room}`} onClose={onClose}>
      <form onSubmit={submit} className="bki-form">
        <label className="bki-field">
          Guest name
          <input value={form.guest_name} onChange={set('guest_name')} aria-label="Guest name" />
        </label>
        <label className="bki-field">
          Mobile
          <input value={form.guest_mobile} onChange={set('guest_mobile')} aria-label="Mobile" />
        </label>
        <label className="bki-field">
          Check-in date
          <input type="date" value={form.check_in_date} onChange={set('check_in_date')} aria-label="Check-in date" />
        </label>
        <label className="bki-field">
          Check-in time
          <input type="time" value={form.check_in_time} onChange={set('check_in_time')} aria-label="Check-in time" />
        </label>
        <label className="bki-field">
          Check-out date
          <input type="date" value={form.check_out_date} onChange={set('check_out_date')} aria-label="Check-out date" />
        </label>
        <label className="bki-field">
          Room
          <input value={form.room} onChange={set('room')} aria-label="Room" />
        </label>
        <label className="bki-field">
          Guests
          <input type="number" min="1" value={form.guest_count} onChange={set('guest_count')} aria-label="Guests" />
        </label>
        <label className="bki-field">
          Total amount
          <input type="number" min="0" value={form.total_amount} onChange={set('total_amount')} aria-label="Total amount" />
        </label>
        <label className="bki-field">
          Notes
          <textarea value={form.notes} onChange={set('notes')} aria-label="Notes" />
        </label>
        {error ? <div className="bki-error" role="alert">{error}</div> : null}
        <button type="submit" className="action-btn btn-primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </Modal>
  )
}

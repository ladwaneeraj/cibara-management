import { useState } from 'react'
import type { MultiBookingPayload, MultiBookingRoom, PaymentMethod } from '../types/booking'
import { createMultiBooking } from '../api/bookings'
import { Modal } from '../components/Modal'
import { PaymentMethodPicker } from '../components/PaymentMethodPicker'

function nextDay(iso: string): string {
  const d = new Date(iso)
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

interface Row {
  room: string
  guest_name: string
  guest_mobile: string
  total_amount: string
  advance: string
}
const emptyRow = (): Row => ({ room: '', guest_name: '', guest_mobile: '', total_amount: '', advance: '' })

// Multi-room booking → create_multi_booking (routes/bookings.py:359). Shared
// dates; one row per room (min 2). OTA sources are not offered — the backend
// rejects them for multi-room.
export function MultiBookingModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const today = new Date().toISOString().slice(0, 10)
  const [checkIn, setCheckIn] = useState(today)
  const [checkInTime, setCheckInTime] = useState('14:00')
  const [checkOut, setCheckOut] = useState(nextDay(today))
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [notes, setNotes] = useState('')
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow()])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setRow = (i: number, k: keyof Row, v: string) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)))
  const addRow = () => setRows((rs) => [...rs, emptyRow()])
  const removeRow = (i: number) => setRows((rs) => (rs.length > 2 ? rs.filter((_, idx) => idx !== i) : rs))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const parsed: MultiBookingRoom[] = rows.map((r) => ({
      room: r.room.trim(),
      guest_name: r.guest_name.trim(),
      guest_mobile: r.guest_mobile.trim(),
      total_amount: parseInt(r.total_amount || '0', 10) || 0,
      advance: parseInt(r.advance || '0', 10) || 0,
    }))
    for (const r of parsed) {
      if (!r.room || !r.guest_name || !r.guest_mobile) {
        setError('Each room needs a room number, guest name and mobile')
        return
      }
      if ((r.advance ?? 0) > r.total_amount) {
        setError(`Advance cannot exceed total for room ${r.room}`)
        return
      }
    }
    const payload: MultiBookingPayload = {
      check_in_date: checkIn,
      check_in_time: checkInTime,
      check_out_date: checkOut,
      payment_method: method,
      notes,
      rooms: parsed,
    }
    setPending(true)
    setError(null)
    try {
      await createMultiBooking(payload)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create bookings')
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal title="New multi-room booking" onClose={onClose}>
      <form onSubmit={submit} className="bki-form">
        <div className="bki-row">
          <label className="bki-field">
            Check-in
            <input type="date" value={checkIn} aria-label="Check-in date" onChange={(e) => setCheckIn(e.target.value)} />
          </label>
          <label className="bki-field">
            Time
            <input type="time" value={checkInTime} aria-label="Check-in time" onChange={(e) => setCheckInTime(e.target.value)} />
          </label>
          <label className="bki-field">
            Check-out
            <input type="date" value={checkOut} aria-label="Check-out date" onChange={(e) => setCheckOut(e.target.value)} />
          </label>
        </div>

        {rows.map((r, i) => (
          <fieldset key={i} className="bki-multi-row">
            <legend>Room {i + 1}</legend>
            <input placeholder="Room" value={r.room} onChange={(e) => setRow(i, 'room', e.target.value)} aria-label={`Room number ${i + 1}`} />
            <input placeholder="Guest name" value={r.guest_name} onChange={(e) => setRow(i, 'guest_name', e.target.value)} aria-label={`Guest name ${i + 1}`} />
            <input placeholder="Mobile" value={r.guest_mobile} onChange={(e) => setRow(i, 'guest_mobile', e.target.value)} aria-label={`Mobile ${i + 1}`} />
            <input type="number" min="0" placeholder="Total" value={r.total_amount} onChange={(e) => setRow(i, 'total_amount', e.target.value)} aria-label={`Total ${i + 1}`} />
            <input type="number" min="0" placeholder="Advance" value={r.advance} onChange={(e) => setRow(i, 'advance', e.target.value)} aria-label={`Advance ${i + 1}`} />
            {rows.length > 2 ? (
              <button type="button" className="action-btn btn-sm" onClick={() => removeRow(i)} aria-label={`Remove room ${i + 1}`}>
                Remove
              </button>
            ) : null}
          </fieldset>
        ))}

        <button type="button" className="action-btn btn-sm" onClick={addRow}>
          + Add room
        </button>

        <PaymentMethodPicker value={method} onChange={setMethod} />
        <label className="bki-field">
          Notes
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" />
        </label>

        {error ? <div className="bki-error" role="alert">{error}</div> : null}
        <button type="submit" className="action-btn btn-primary" disabled={pending}>
          {pending ? 'Creating…' : `Create ${rows.length} bookings`}
        </button>
      </form>
    </Modal>
  )
}

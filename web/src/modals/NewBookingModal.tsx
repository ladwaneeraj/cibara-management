import { useState } from 'react'
import type { BookingSource, CreateBookingPayload, PaymentMethod } from '../types/booking'
import { checkAvailability, createBooking } from '../api/bookings'
import { Modal } from '../components/Modal'
import { PaymentMethodPicker } from '../components/PaymentMethodPicker'
import { isOtaPrepaid } from '../lib/booking'

function nextDay(iso: string): string {
  const d = new Date(iso)
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Availability-first New Booking. Pick dates → check_availability → choose a
// free room → fill details → create_booking (routes/bookings.py:235). OTA
// sources (mmt/agoda) collect no advance and carry commission fields.
export function NewBookingModal({
  initialDate,
  onClose,
  onDone,
  onSwitchToMulti,
}: {
  initialDate?: string
  onClose: () => void
  onDone: () => void
  onSwitchToMulti?: () => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const ci0 = initialDate || today
  const [checkIn, setCheckIn] = useState(ci0)
  const [checkInTime, setCheckInTime] = useState('14:00')
  const [checkOut, setCheckOut] = useState(nextDay(ci0))
  const [source, setSource] = useState<BookingSource>('normal')

  const [rooms, setRooms] = useState<string[] | null>(null)
  const [room, setRoom] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const [guestName, setGuestName] = useState('')
  const [mobile, setMobile] = useState('')
  const [guests, setGuests] = useState('1')
  const [total, setTotal] = useState('')
  const [advance, setAdvance] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [otaTotal, setOtaTotal] = useState('')
  const [otaCommission, setOtaCommission] = useState('')
  const [otaCommissionGst, setOtaCommissionGst] = useState('')
  const [notes, setNotes] = useState('')

  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ota = isOtaPrepaid(source)

  const runCheck = async () => {
    setChecking(true)
    setError(null)
    setRoom(null)
    try {
      const avail = await checkAvailability({ check_in_date: checkIn, check_out_date: checkOut })
      setRooms(avail)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check availability')
      setRooms(null)
    } finally {
      setChecking(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!room) {
      setError('Pick an available room first')
      return
    }
    if (!guestName.trim() || !mobile.trim()) {
      setError('Guest name and mobile are required')
      return
    }
    const totalNum = ota ? parseInt(otaTotal || '0', 10) || 0 : parseInt(total || '0', 10) || 0
    const payload: CreateBookingPayload = {
      room,
      guest_name: guestName.trim(),
      guest_mobile: mobile.trim(),
      check_in_date: checkIn,
      check_in_time: checkInTime,
      check_out_date: checkOut,
      total_amount: totalNum,
      guest_count: parseInt(guests || '1', 10) || 1,
      booking_source: source,
      notes,
    }
    if (ota) {
      payload.ota_total_amount = totalNum
      payload.ota_commission = parseFloat(otaCommission || '0') || 0
      payload.ota_commission_gst = parseFloat(otaCommissionGst || '0') || 0
    } else {
      payload.paid_amount = parseInt(advance || '0', 10) || 0
      payload.payment_method = method
    }
    setPending(true)
    setError(null)
    try {
      await createBooking(payload)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create booking')
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal title="New booking" onClose={onClose}>
      <form onSubmit={submit} className="bki-form">
        <div className="bki-row">
          <label className="bki-field">
            Check-in
            <input
              type="date"
              value={checkIn}
              aria-label="Check-in date"
              onChange={(e) => {
                setCheckIn(e.target.value)
                setRooms(null)
              }}
            />
          </label>
          <label className="bki-field">
            Time
            <input type="time" value={checkInTime} aria-label="Check-in time" onChange={(e) => setCheckInTime(e.target.value)} />
          </label>
          <label className="bki-field">
            Check-out
            <input
              type="date"
              value={checkOut}
              aria-label="Check-out date"
              onChange={(e) => {
                setCheckOut(e.target.value)
                setRooms(null)
              }}
            />
          </label>
        </div>

        <label className="bki-field">
          Source
          <select
            value={source}
            aria-label="Booking source"
            onChange={(e) => {
              setSource(e.target.value as BookingSource)
              setRooms(null)
            }}
          >
            <option value="normal">Walk-in / Phone</option>
            <option value="mmt">MMT</option>
            <option value="agoda">Agoda</option>
          </select>
        </label>

        <button type="button" className="action-btn btn-sm" onClick={runCheck} disabled={checking}>
          {checking ? 'Checking…' : 'Check availability'}
        </button>

        {rooms && rooms.length === 0 ? (
          <div className="bki-note" role="alert">No rooms available for these dates.</div>
        ) : null}

        {rooms && rooms.length > 0 ? (
          <div className="bki-row bki-rooms" role="group" aria-label="Available rooms">
            {rooms.map((r) => (
              <button
                key={r}
                type="button"
                className={`payment-btn ${room === r ? 'active' : ''}`}
                onClick={() => setRoom(r)}
              >
                Room {r}
              </button>
            ))}
          </div>
        ) : null}

        {room ? (
          <>
            <label className="bki-field">
              Guest name
              <input value={guestName} onChange={(e) => setGuestName(e.target.value)} aria-label="Guest name" />
            </label>
            <label className="bki-field">
              Mobile
              <input value={mobile} onChange={(e) => setMobile(e.target.value)} aria-label="Mobile" />
            </label>
            <label className="bki-field">
              Guests
              <input type="number" min="1" value={guests} onChange={(e) => setGuests(e.target.value)} aria-label="Guests" />
            </label>
            {ota ? (
              <>
                <label className="bki-field">
                  OTA total amount
                  <input type="number" min="0" value={otaTotal} onChange={(e) => setOtaTotal(e.target.value)} aria-label="Total amount" />
                </label>
                <label className="bki-field">
                  OTA commission
                  <input type="number" min="0" value={otaCommission} onChange={(e) => setOtaCommission(e.target.value)} aria-label="OTA commission" />
                </label>
                <label className="bki-field">
                  OTA commission GST
                  <input type="number" min="0" value={otaCommissionGst} onChange={(e) => setOtaCommissionGst(e.target.value)} aria-label="OTA commission GST" />
                </label>
              </>
            ) : (
              <>
                <label className="bki-field">
                  Total amount
                  <input type="number" min="0" value={total} onChange={(e) => setTotal(e.target.value)} aria-label="Total amount" />
                </label>
                <label className="bki-field">
                  Advance collected
                  <input type="number" min="0" value={advance} onChange={(e) => setAdvance(e.target.value)} aria-label="Advance" />
                </label>
                <PaymentMethodPicker value={method} onChange={setMethod} />
              </>
            )}
            <label className="bki-field">
              Notes
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" />
            </label>
          </>
        ) : null}

        {error ? <div className="bki-error" role="alert">{error}</div> : null}

        <div className="bki-row">
          <button type="submit" className="action-btn btn-primary" disabled={pending || !room}>
            {pending ? 'Creating…' : 'Create booking'}
          </button>
          {onSwitchToMulti ? (
            <button type="button" className="action-btn btn-sm" onClick={onSwitchToMulti}>
              Multiple rooms
            </button>
          ) : null}
        </div>
      </form>
    </Modal>
  )
}

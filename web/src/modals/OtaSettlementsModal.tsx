import { useCallback, useEffect, useState } from 'react'
import type { Booking, OtaSettlement } from '../types/booking'
import { getMmtUnsettled, getOtaSettlements, markOtaSettlement } from '../api/bookings'
import { formatMoney } from '../lib/format'
import { otaSourceLabel } from '../lib/booking'
import { Modal } from '../components/Modal'

// OTA (MMT/Agoda) bank settlements. Lists unsettled OTA bookings and recorded
// settlements; marking one → mark_ota_settlement (routes/bookings.py:1601).
// Permission (settlement.manage) is gated by the toolbar button in the shell.
export function OtaSettlementsModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const today = new Date().toISOString().slice(0, 10)
  const [unsettled, setUnsettled] = useState<Booking[]>([])
  const [settled, setSettled] = useState<OtaSettlement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [u, s] = await Promise.all([getMmtUnsettled(), getOtaSettlements()])
      setUnsettled(u)
      setSettled(s)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load settlements')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Modal title="OTA settlements" onClose={onClose}>
      {loading ? (
        <div className="bki-empty"><span className="bki-spinner" /> Loading…</div>
      ) : (
        <>
          {error ? <div className="bki-error" role="alert">{error}</div> : null}
          <h4>Awaiting settlement</h4>
          {unsettled.length === 0 ? (
            <p className="bki-note">Nothing awaiting settlement.</p>
          ) : (
            unsettled.map((b) => (
              <SettleRow
                key={b.booking_id}
                booking={b}
                today={today}
                busy={busy === b.booking_id}
                onMark={async (payload) => {
                  setBusy(b.booking_id)
                  setError(null)
                  try {
                    await markOtaSettlement(payload)
                    await load()
                    onChanged()
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Could not mark settlement')
                  } finally {
                    setBusy(null)
                  }
                }}
              />
            ))
          )}
          <h4>Recorded settlements</h4>
          {settled.length === 0 ? (
            <p className="bki-note">None yet.</p>
          ) : (
            <ul className="bki-settled">
              {settled.map((s) => (
                <li key={s.id}>
                  {otaSourceLabel(s.platform)} · {s.guest_name ?? ''} · {formatMoney(s.settlement_amount)} · {s.settlement_date}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  )
}

function SettleRow({
  booking,
  today,
  busy,
  onMark,
}: {
  booking: Booking
  today: string
  busy: boolean
  onMark: (payload: { booking_id: string; settlement_date: string; settlement_amount: number; utr?: string }) => void
}) {
  const [date, setDate] = useState(today)
  const [amount, setAmount] = useState(String(booking.net_receivable ?? ''))
  const [utr, setUtr] = useState('')
  return (
    <div className="bki-settle-row">
      <div>
        <strong>{otaSourceLabel(booking.booking_source)}</strong> · Room {booking.room} · {booking.guest_name} ·{' '}
        net {formatMoney(booking.net_receivable ?? 0)}
      </div>
      <div className="bki-row">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Settlement date" />
        <input
          type="number"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label="Settlement amount"
          placeholder="Amount"
        />
        <input value={utr} onChange={(e) => setUtr(e.target.value)} aria-label="UTR" placeholder="UTR" />
        <button
          type="button"
          className="action-btn btn-sm btn-primary"
          disabled={busy}
          onClick={() =>
            onMark({
              booking_id: booking.booking_id,
              settlement_date: date,
              settlement_amount: parseFloat(amount || '0') || 0,
              utr,
            })
          }
        >
          {busy ? 'Saving…' : 'Mark received'}
        </button>
      </div>
    </div>
  )
}

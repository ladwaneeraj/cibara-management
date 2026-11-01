import { useEffect, useState } from 'react'
import type { Booking } from '../types/booking'
import { getUpcomingList } from '../api/bookings'
import { formatDate, formatTime, formatMoney } from '../lib/format'
import { Modal } from '../components/Modal'

// Printable arrivals sheet — today's + future confirmed arrivals
// (get_upcoming_bookings_list). Print uses the browser print dialog.
export function ArrivalsSheet({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getUpcomingList()
      .then((list) => {
        if (alive) setRows(list)
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load arrivals')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <Modal title="Arrivals sheet" onClose={onClose}>
      {loading ? (
        <div className="bki-empty"><span className="bki-spinner" /> Loading…</div>
      ) : error ? (
        <div className="bki-error" role="alert">{error}</div>
      ) : rows.length === 0 ? (
        <p className="bki-note">No upcoming arrivals.</p>
      ) : (
        <>
          <table className="table-erp bki-arrivals">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Room</th>
                <th>Guest</th>
                <th>Mobile</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.booking_id}>
                  <td>{formatDate(b.check_in_date)}</td>
                  <td>{formatTime(b.check_in_time)}</td>
                  <td>{b.room}</td>
                  <td>{b.guest_name}</td>
                  <td>{b.guest_mobile}</td>
                  <td>{formatMoney(b.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="action-btn btn-primary" onClick={() => window.print()}>
            Print
          </button>
        </>
      )}
    </Modal>
  )
}

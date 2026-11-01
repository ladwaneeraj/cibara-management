// Bookings tab shell: toolbar, filter pills, search, view switch, and the
// active view. Mounts once at page load (so the room-calendar bridge globals
// are always available) and renders into #bookings-react-root. No top stat
// cards (per the brief). Drawer + modals are wired in later tasks via the
// selectedId / newBooking state already tracked here.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { installBridge, uninstallBridge } from './bridge'
import { useBookings } from './state/useBookings'
import { ListView } from './views/ListView'
import { CalendarView } from './views/CalendarView'
import { BookingDrawer } from './components/BookingDrawer'
import type { BookingAction } from './components/QuickActions'
import { PaymentModal } from './modals/PaymentModal'
import { CancelModal } from './modals/CancelModal'
import { ConvertCheckinModal } from './modals/ConvertCheckinModal'
import { UpdateBookingModal } from './modals/UpdateBookingModal'
import { NewBookingModal } from './modals/NewBookingModal'
import { MultiBookingModal } from './modals/MultiBookingModal'
import { ArrivalsSheet } from './modals/ArrivalsSheet'
import { OtaSettlementsModal } from './modals/OtaSettlementsModal'
import { fetchFromMmt } from './api/bookings'
import { buildWhatsappUrl } from './lib/whatsapp'
import type { Booking } from './types/booking'
import type { BookingFilter, SortKey } from './lib/bookingFilters'

type View = 'list' | 'calendar' | 'timeline'

const FILTERS: { key: BookingFilter; label: string }[] = [
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'today', label: 'Today' },
  { key: 'all', label: 'All' },
  { key: 'completed', label: 'Checked In' },
  { key: 'cancelled', label: 'Cancelled' },
]

const VIEWS: { key: View; label: string; icon: string }[] = [
  { key: 'list', label: 'List', icon: 'fa-list' },
  { key: 'calendar', label: 'Calendar', icon: 'fa-calendar-alt' },
  { key: 'timeline', label: 'Timeline', icon: 'fa-stream' },
]

function hasPerm(perm: string): boolean {
  const a = window.CibaraAuth
  if (a && typeof a.hasPermission === 'function') {
    try {
      return !!a.hasPermission(perm)
    } catch {
      return false
    }
  }
  return true // no gate available (dev harness) → show
}

export function BookingsApp() {
  const { bookings, loading, error, refresh } = useBookings()
  const [filter, setFilter] = useState<BookingFilter>('upcoming')
  const [view, setView] = useState<View>('list')
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortKey>('checkin')
  const [calMonth, setCalMonth] = useState<Date>(() => new Date())
  const [selectedId, setSelectedId] = useState<string | null>(null) // drawer
  const [newBooking, setNewBooking] = useState<{ date?: string; multi?: boolean } | null>(null)
  const [modalAction, setModalAction] = useState<{ kind: BookingAction; booking: Booking } | null>(null) // Task 12
  const [arrivalsOpen, setArrivalsOpen] = useState(false)
  const [otaOpen, setOtaOpen] = useState(false)
  const [fetching, setFetching] = useState(false)
  const canOta = useMemo(() => hasPerm('settlement.manage'), [])

  const doFetchFromMmt = useCallback(async () => {
    setFetching(true)
    try {
      await fetchFromMmt()
      await refresh()
    } catch {
      /* surfaced by the list error state on the next load */
    } finally {
      setFetching(false)
    }
  }, [refresh])

  const openDrawer = useCallback((id: string) => setSelectedId(id), [])
  const openNewBooking = useCallback((opts?: { date?: string }) => setNewBooking(opts ?? {}), [])

  const selectedBooking = selectedId ? bookings.find((b) => b.booking_id === selectedId) ?? null : null

  const handleAction = useCallback((action: BookingAction, booking: Booking) => {
    if (action === 'whatsapp') {
      const text = `Hello ${booking.guest_name}, regarding your booking (Room ${booking.room}).`
      window.open(buildWhatsappUrl(booking.guest_mobile, text), '_blank', 'noopener')
      return
    }
    // convert / cancel / collect / edit → open the matching action modal
    setModalAction({ kind: action, booking })
  }, [])

  const closeModal = useCallback(() => setModalAction(null), [])
  const afterAction = useCallback(() => {
    setModalAction(null)
    setSelectedId(null)
    void refresh()
  }, [refresh])
  const afterNew = useCallback(() => {
    setNewBooking(null)
    void refresh()
  }, [refresh])

  useEffect(() => {
    installBridge({ refresh, openDrawer, openNewBooking })
    return () => uninstallBridge()
  }, [refresh, openDrawer, openNewBooking])

  return (
    <div
      className="bki-app"
      data-newbooking={newBooking ? '1' : ''}
      data-modal={modalAction?.kind ?? ''}
    >
      <div className="section-title bk-section-title">
        <h2>Room Bookings</h2>
        <div className="bk-toolbar bki-toolbar">
          <button
            className="action-btn btn-sm bk-tool-btn bk-tool-slate"
            type="button"
            onClick={() => setArrivalsOpen(true)}
          >
            <i className="fas fa-print" aria-hidden="true" /> <span>Arrivals Sheet</span>
          </button>
          <button
            className="action-btn btn-sm bk-tool-btn bk-tool-orange"
            type="button"
            onClick={doFetchFromMmt}
            disabled={fetching}
          >
            <i className="fas fa-sync-alt" aria-hidden="true" /> <span>{fetching ? 'Fetching…' : 'Fetch Bookings'}</span>
          </button>
          {canOta ? (
            <button
              className="action-btn btn-sm bk-tool-btn bk-tool-blue"
              type="button"
              onClick={() => setOtaOpen(true)}
            >
              <i className="fas fa-university" aria-hidden="true" /> <span>OTA Settlements</span>
            </button>
          ) : null}
          <button
            className="action-btn btn-sm btn-primary bk-tool-btn bk-tool-primary"
            type="button"
            onClick={() => openNewBooking()}
          >
            <i className="fas fa-plus" aria-hidden="true" /> <span>New Booking</span>
          </button>
        </div>
      </div>

      <div className="filter-container bk-filter-row">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`booking-filter-btn ${filter === f.key ? 'active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="bki-row">
        <input
          className="bki-search"
          type="search"
          placeholder="Search guest, phone or room"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search bookings"
        />
        <label className="bki-sort">
          Sort
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            aria-label="Sort bookings"
          >
            <option value="checkin">Check-in</option>
            <option value="amount">Amount</option>
            <option value="balance">Balance due</option>
            <option value="recent">Most recent</option>
          </select>
        </label>
      </div>

      <div className="view-selector bk-view-selector">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            className={`view-btn ${view === v.key ? 'active' : ''}`}
            onClick={() => setView(v.key)}
          >
            <i className={`fas ${v.icon}`} aria-hidden="true" /> <span>{v.label}</span>
          </button>
        ))}
      </div>

      {error ? (
        <div className="bki-empty" role="alert">
          {error}
        </div>
      ) : null}

      {loading && bookings.length === 0 ? (
        <div className="bki-empty">
          <span className="bki-spinner" /> Loading bookings…
        </div>
      ) : view === 'list' ? (
        <ListView bookings={bookings} filter={filter} query={query} sortBy={sortBy} onOpen={openDrawer} />
      ) : view === 'calendar' ? (
        <CalendarView bookings={bookings} month={calMonth} onMonthChange={setCalMonth} onOpen={openDrawer} />
      ) : (
        <div className="bki-empty">Timeline view coming up…</div>
      )}

      <BookingDrawer booking={selectedBooking} onAction={handleAction} onClose={() => setSelectedId(null)} />

      {modalAction?.kind === 'collect' ? (
        <PaymentModal booking={modalAction.booking} onClose={closeModal} onDone={afterAction} />
      ) : null}
      {modalAction?.kind === 'cancel' ? (
        <CancelModal booking={modalAction.booking} onClose={closeModal} onDone={afterAction} />
      ) : null}
      {modalAction?.kind === 'convert' ? (
        <ConvertCheckinModal booking={modalAction.booking} onClose={closeModal} onDone={afterAction} />
      ) : null}
      {modalAction?.kind === 'edit' ? (
        <UpdateBookingModal booking={modalAction.booking} onClose={closeModal} onDone={afterAction} />
      ) : null}

      {newBooking && !newBooking.multi ? (
        <NewBookingModal
          initialDate={newBooking.date}
          onClose={() => setNewBooking(null)}
          onDone={afterNew}
          onSwitchToMulti={() => setNewBooking({ multi: true })}
        />
      ) : null}
      {newBooking?.multi ? (
        <MultiBookingModal onClose={() => setNewBooking(null)} onDone={afterNew} />
      ) : null}

      {arrivalsOpen ? <ArrivalsSheet onClose={() => setArrivalsOpen(false)} /> : null}
      {otaOpen ? <OtaSettlementsModal onClose={() => setOtaOpen(false)} onChanged={() => void refresh()} /> : null}
    </div>
  )
}

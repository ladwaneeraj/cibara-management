// List view: filter → search → sort → render cards. Container reuses the
// classic #bookings-list look via .bookings-container.
import { useMemo } from 'react'
import type { Booking } from '../types/booking'
import {
  applyFilter,
  buildBookingGroupIndex,
  searchBookings,
  sortBookings,
  type BookingFilter,
  type SortKey,
} from '../lib/bookingFilters'
import { BookingCard } from '../components/BookingCard'
import { EmptyState } from '../components/EmptyState'

const FILTER_WORD: Record<BookingFilter, string> = {
  upcoming: 'upcoming',
  today: 'today',
  all: '',
  completed: 'checked-in',
  cancelled: 'cancelled',
}

export interface ListViewProps {
  bookings: Booking[]
  filter: BookingFilter
  query: string
  sortBy?: SortKey
  onOpen: (bookingId: string) => void
}

export function ListView({ bookings, filter, query, sortBy = 'checkin', onOpen }: ListViewProps) {
  const groupIndex = useMemo(() => buildBookingGroupIndex(bookings), [bookings])
  const rows = useMemo(() => {
    const filtered = searchBookings(applyFilter(bookings, filter), query)
    return sortBookings(filtered, filter, sortBy)
  }, [bookings, filter, query, sortBy])

  if (rows.length === 0) {
    const word = FILTER_WORD[filter]
    return <EmptyState message={`No ${word ? word + ' ' : ''}bookings found`} />
  }

  return (
    <div className="bookings-container" id="bookings-list">
      {rows.map((b) => (
        <BookingCard
          key={b.booking_id}
          booking={b}
          groupSize={b.group_booking_id ? (groupIndex.get(b.group_booking_id)?.length ?? 0) : 0}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}

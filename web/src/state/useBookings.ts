import { useCallback, useEffect, useRef, useState } from 'react'
import { getBookings } from '../api/bookings'
import type { Booking } from '../types/booking'

export interface UseBookings {
  bookings: Booking[]
  loading: boolean
  error: string | null
  lastUpdated: number | null
  refresh: () => Promise<void>
}

// Loads /get_bookings and exposes a refresh(). A failed refresh keeps the last
// good data and surfaces the error — a transient network blip must not blank
// the list.
export function useBookings(): UseBookings {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  // Guard against state updates after unmount (a late /get_bookings response
  // must not setState on a torn-down tree).
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await getBookings()
      if (!mounted.current) return
      setBookings(list)
      setError(null)
      setLastUpdated(Date.now())
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Failed to load bookings')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [refresh])

  return { bookings, loading, error, lastUpdated, refresh }
}

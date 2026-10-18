/**
 * Data hooks for the analytics page. Every read goes through lib/api (Bearer
 * access JWT, refresh-on-401, success:false => ApiError) — no bespoke fetch.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, get } from '@/lib/api'
import type { AnalyticsOverview, CustomerInsights, CustomerSegment, SegmentDimension } from './types'

const overviewKey = (from: string, to: string) => ['analytics', 'overview', from, to] as const

/** One request per window: GET /api/v2/analytics/overview?start=&end= */
export function useAnalyticsOverview(from: string, to: string) {
  return useQuery({
    queryKey: overviewKey(from, to),
    queryFn: ({ signal }) => get<AnalyticsOverview>('/api/v2/analytics/overview', { start: from, end: to }, signal),
    enabled: Boolean(from && to),
    placeholderData: (prev) => prev, // keep the old figures on screen while a new range loads
  })
}

/** The "refresh" button: asks the server to skip its 120 s cache (fresh=true)
 *  and writes the answer into the same query so every section updates. */
export function useRefreshOverview(from: string, to: string) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () => get<AnalyticsOverview>('/api/v2/analytics/overview', { start: from, end: to, fresh: true }),
    onSuccess: (data) => qc.setQueryData(overviewKey(from, to), data),
  })
  return { refresh: () => m.mutateAsync(), pending: m.isPending, error: m.error }
}

/** Existing CRM insights (customer.manage). Cached server-side for 5 minutes. */
export function useCustomerInsights() {
  return useQuery({
    queryKey: ['analytics', 'customers'],
    queryFn: ({ signal }) => get<CustomerInsights>('/customer_insights', undefined, signal),
    staleTime: 5 * 60_000,
  })
}

/** Guests in one cohort (drill-through). `key` is the 0-based band index. */
export function useCustomerSegment(dimension: SegmentDimension | null, key: number | null) {
  return useQuery({
    queryKey: ['analytics', 'customer_segment', dimension, key],
    queryFn: ({ signal }) => get<CustomerSegment>('/customer_segment', { dimension: dimension!, key: key! }, signal),
    enabled: dimension !== null && key !== null,
    staleTime: 5 * 60_000,
  })
}

/** True when the viewer lacks the permission for this endpoint (HTTP 403). */
export function isForbidden(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403
}

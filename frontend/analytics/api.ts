/**
 * Data hooks for the analytics page. Every read goes through lib/api (Bearer
 * access JWT, refresh-on-401, success:false => ApiError) — no bespoke fetch.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, get, post } from '@/lib/api'
import type { AnalyticsOverview, CustomerInsights, CustomerSegment, Demographics, FinancialsReport, Gstr1Summary, SegmentDimension } from './types'

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

const financialsKey = (from: string, to: string) => ['analytics', 'financials', from, to] as const

/** Payment/expense-basis figures for the Financial performance section:
 *  POST /reports (the old Analytics tab's source). `from`/`to` are inclusive
 *  YYYY-MM-DD; the legacy route makes `to` exclusive itself. */
export function useFinancials(from: string, to: string) {
  return useQuery({
    queryKey: financialsKey(from, to),
    queryFn: () => post<FinancialsReport>('/reports', { start_date: from, end_date: to }),
    enabled: Boolean(from && to),
    placeholderData: (prev) => prev,
  })
}

/** Guest demographics (customer.manage): age distribution + pincode/taluk
 *  footfall + resolved geo points for the map. All-time, OCR-sourced. */
export function useDemographics() {
  return useQuery({
    queryKey: ['analytics', 'demographics'],
    queryFn: ({ signal }) => get<Demographics>('/customer_analytics', undefined, signal),
    staleTime: 5 * 60_000,
  })
}

/** GSTR-1 summary for the window (analytics.view via the Reports gate).
 *  `enabled` lets the caller defer the fetch until the Reports tab is open. */
export function useGstr1(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'gstr1', from, to],
    queryFn: () => post<Gstr1Summary>('/reports/gstr1_summary', { start_date: from, end_date: to }),
    enabled: enabled && Boolean(from && to),
    placeholderData: (prev) => prev,
  })
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

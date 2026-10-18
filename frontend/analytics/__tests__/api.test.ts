import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { json, mockFetch, signIn } from '@/test/utils'
import { isForbidden, useAnalyticsOverview, useCustomerInsights, useRefreshOverview } from '../api'
import type { AnalyticsOverview } from '../types'

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children)
}

const payload = { success: true, window: { from: '2026-10-12', to: '2026-10-18', days: 7 }, findings: [] } as unknown as AnalyticsOverview

describe('useAnalyticsOverview', () => {
  it('calls /api/v2/analytics/overview with start/end and returns the typed payload', async () => {
    signIn('admin')
    const { calls } = mockFetch({ 'GET /api/v2/analytics/overview': payload })
    const { result } = renderHook(() => useAnalyticsOverview('2026-10-12', '2026-10-18'), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.window.days).toBe(7)
    expect(calls).toHaveLength(1)
    const u = new URL(calls[0].url, 'http://x')
    expect(u.pathname).toBe('/api/v2/analytics/overview')
    expect(u.searchParams.get('start')).toBe('2026-10-12')
    expect(u.searchParams.get('end')).toBe('2026-10-18')
    expect(u.searchParams.has('fresh')).toBe(false)
    expect(calls[0].headers.Authorization).toBe('Bearer test-token')
  })

  it('a refresh bypasses the server cache (fresh=true) and replaces the cached data', async () => {
    signIn('admin')
    let n = 0
    const { calls } = mockFetch({
      'GET /api/v2/analytics/overview': () => ({ ...payload, generated_at: `g${++n}` }),
    })
    const w = wrapper()
    const { result } = renderHook(
      () => ({ q: useAnalyticsOverview('2026-10-12', '2026-10-18'), r: useRefreshOverview('2026-10-12', '2026-10-18') }),
      { wrapper: w },
    )
    await waitFor(() => expect(result.current.q.data?.generated_at).toBe('g1'))
    await act(async () => { await result.current.r.refresh() })
    await waitFor(() => expect(result.current.q.data?.generated_at).toBe('g2'))
    expect(new URL(calls[1].url, 'http://x').searchParams.get('fresh')).toBe('true')
  })
})

describe('useCustomerInsights', () => {
  it('calls /customer_insights', async () => {
    signIn('admin')
    const { calls } = mockFetch({ 'GET /customer_insights': { success: true, kpis: { total_customers: 3 } } })
    const { result } = renderHook(() => useCustomerInsights(), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.kpis.total_customers).toBe(3)
    expect(calls[0].url).toBe('/customer_insights')
  })

  it('surfaces a 403 as a forbidden error', async () => {
    signIn('admin')
    mockFetch({ 'GET /customer_insights': () => json({ success: false, message: 'Permission denied' }, 403) })
    const { result } = renderHook(() => useCustomerInsights(), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(isForbidden(result.current.error)).toBe(true)
    expect(isForbidden(new ApiError('boom', 500))).toBe(false)
    expect(isForbidden(null)).toBe(false)
  })
})

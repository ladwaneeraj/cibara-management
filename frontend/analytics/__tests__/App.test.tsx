import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { json, mockFetch, renderWith, signIn } from '@/test/utils'
import { useAuth } from '@/lib/auth'
import { App, AuthGate } from '../App'
import { CUSTOMERS, DEMOGRAPHICS, FINANCIALS, GSTR1, OVERVIEW } from './fixtures'

const ok = () => ({
  'GET /api/v2/analytics/overview': OVERVIEW,
  'POST /reports': FINANCIALS,
  'POST /reports/gstr1_summary': GSTR1,
  'GET /customer_analytics': DEMOGRAPHICS,
  'GET /customer_insights': CUSTOMERS,
})

describe('analytics App', () => {
  it('renders every section in order, plus the findings strip', async () => {
    signIn('admin')
    mockFetch(ok())
    renderWith(<App />)

    expect(screen.getByRole('heading', { level: 1, name: /analytics/i })).toBeInTheDocument()
    await screen.findByText('Guest base') // customers loaded too

    const order = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(order).toEqual([
      'What to look at', 'Financial performance', 'Overview', 'Channel mix', 'Booking pace', 'Seasonality', 'Length of stay & lead time', 'Guests',
    ])

    const strip = screen.getByRole('region', { name: 'What to look at' })
    expect(strip).toHaveTextContent('MMT net ADR trails direct by 24%')
    expect(strip).toHaveTextContent('Next 7 nights are 48% booked')
    expect(screen.getByText('62.5%')).toBeInTheDocument() // KPI strip is live data
  })

  it('omits the findings strip when the server has nothing to say', async () => {
    signIn('admin')
    mockFetch({ ...ok(), 'GET /api/v2/analytics/overview': { ...OVERVIEW, findings: [] } })
    renderWith(<App />)
    await screen.findByText('62.5%')
    expect(screen.queryByRole('heading', { name: 'What to look at' })).not.toBeInTheDocument()
  })

  it('makes exactly one overview request (7-day default) and no raw bill/payment arrays are needed', async () => {
    signIn('admin')
    const { calls } = mockFetch(ok())
    renderWith(<App />)
    await screen.findByText('62.5%')
    const ov = calls.filter((c) => c.url.startsWith('/api/v2/analytics/overview'))
    expect(ov).toHaveLength(1)
    const u = new URL(ov[0].url, 'http://x')
    expect(u.searchParams.get('start')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(u.searchParams.get('end')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(calls.filter((c) => c.url.startsWith('/customer_insights'))).toHaveLength(1)
  })

  it('changing the range refetches with the new window', async () => {
    signIn('admin')
    const { calls } = mockFetch(ok())
    renderWith(<App />)
    await screen.findByText('62.5%')
    await userEvent.click(screen.getByRole('radio', { name: 'Last 30 days' }))
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/api/v2/analytics/overview'))).toHaveLength(2))
    const [a, b] = calls.filter((c) => c.url.startsWith('/api/v2/analytics/overview')).map((c) => new URL(c.url, 'http://x').searchParams)
    expect(a.get('end')).toBe(b.get('end'))
    expect(a.get('start')).not.toBe(b.get('start'))
  })

  it('Refresh asks the server to skip its cache', async () => {
    signIn('admin')
    const { calls } = mockFetch(ok())
    renderWith(<App />)
    await screen.findByText('62.5%')
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(calls.some((c) => c.url.includes('fresh=true'))).toBe(true))
  })

  it('hides Customers on a 403 but keeps the rest of the page', async () => {
    signIn('admin')
    mockFetch({ ...ok(), 'GET /customer_insights': () => json({ success: false, message: 'Permission denied' }, 403) })
    renderWith(<App />)
    await screen.findByText('62.5%')
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Customers' })).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Channel mix' })).toBeInTheDocument()
  })

  it('shows an error with retry when the overview fails', async () => {
    signIn('admin')
    mockFetch({ ...ok(), 'GET /api/v2/analytics/overview': () => json({ success: false, message: 'Analytics is warming up' }, 500) })
    renderWith(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Analytics is warming up')
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Channel mix' })).not.toBeInTheDocument()
  })

  it('links back to the classic app', () => {
    signIn('admin')
    mockFetch(ok())
    renderWith(<App />)
    expect(screen.getByRole('link', { name: /back to app/i })).toHaveAttribute('href', '/')
  })

  it('merges CRM + demographics into one Guests section', async () => {
    signIn('admin')
    mockFetch(ok())
    renderWith(<App />)
    expect(await screen.findByRole('heading', { level: 2, name: 'Guests' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Guest base & loyalty' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Age distribution' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Footfall by pincode' })).not.toBeInTheDocument()
  })

  it('switches to the Reports tab: transactions, export and GSTR-1', async () => {
    signIn('admin')
    mockFetch(ok())
    renderWith(<App />)
    await screen.findByText('62.5%')
    await userEvent.click(screen.getByRole('tab', { name: 'Reports' }))
    expect(await screen.findByRole('heading', { name: 'Transactions' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'GSTR-1 summary' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /export csv/i })).toBeInTheDocument()
  })
})

describe('AuthGate', () => {
  it('sends an anonymous visitor to the classic login', () => {
    useAuth.setState({ status: 'anonymous', user: null, permissions: new Set(), token: null })
    const redirect = vi.fn()
    renderWith(<AuthGate redirect={redirect}><div>secret</div></AuthGate>)
    expect(redirect).toHaveBeenCalled()
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
  })

  it('shows a no-access note without analytics.view', () => {
    signIn('manager')
    renderWith(<AuthGate redirect={vi.fn()}><div>secret</div></AuthGate>)
    expect(screen.getByText(/do not have access/i)).toBeInTheDocument()
    expect(screen.queryByText('secret')).not.toBeInTheDocument()
  })

  it('renders children for an admin', () => {
    signIn('admin')
    renderWith(<AuthGate redirect={vi.fn()}><div>secret</div></AuthGate>)
    expect(screen.getByText('secret')).toBeInTheDocument()
  })
})

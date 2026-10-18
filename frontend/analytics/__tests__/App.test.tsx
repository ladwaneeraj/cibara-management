import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { json, mockFetch, renderWith, signIn } from '@/test/utils'
import { useAuth } from '@/lib/auth'
import { App, AuthGate } from '../App'

const overview = { success: true, window: { from: '2026-10-12', to: '2026-10-18', days: 7 } }

describe('analytics App shell', () => {
  it('renders the page title and the section headers', async () => {
    signIn('admin')
    mockFetch({
      'GET /api/v2/analytics/overview': overview,
      'GET /customer_insights': () => json({ success: false, message: 'forbidden' }, 403),
    })
    renderWith(<App />)
    expect(screen.getByRole('heading', { level: 1, name: /analytics/i })).toBeInTheDocument()
    for (const name of ['Overview', 'Channel mix', 'Booking pace', 'Seasonality', 'Customers']) {
      expect(await screen.findByRole('heading', { level: 2, name })).toBeInTheDocument()
    }
  })

  it('links back to the classic app', () => {
    signIn('admin')
    mockFetch({ 'GET /api/v2/analytics/overview': overview })
    renderWith(<App />)
    expect(screen.getByRole('link', { name: /back to app/i })).toHaveAttribute('href', '/')
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

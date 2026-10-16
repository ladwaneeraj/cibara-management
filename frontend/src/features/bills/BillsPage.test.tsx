import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { mockFetch, renderWith, signIn } from '@/test/utils'
import { BillsPage } from './BillsPage'

const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `b${i}`, bill_number: `CC/2026/10/0000${i}`, guest_name: `Guest ${i}`, guest_mobile: '9876543210', room: '201',
  checkin_time: '2026-10-05 12:00', checkout_time: '2026-10-06 11:00', days_stayed: 1, total_amount: 1200,
  payment_cash: 1200, payment_online: 0, payment_ota: 0, refunds: 0, discounts: 0, balance: 0, status: 'completed',
  booking_source: 'normal', invoice_type: 'B2C', recipient_gstin: '', recipient_legal_name: '', superseded_by_revert: false,
  is_cancellation_charge: false, linked_credit_note_ids: [], pdf_url: '', activity: {}, gst: { tax: 57.14, taxable: 1142.86, label: '5%' }, ...over,
})
const summary = { summary: { cash: 2400, online: 0, revenue: 2400, invoices: 2, pending_count: 0, pending_amount: 0, gst: 114.28, gst_accommodation: 114.28, gst_services: 0, cancelled: 1, b2b: 0 } }

describe('BillsPage', () => {
  beforeEach(() => signIn('admin'))

  it('lists bills with pills and pages with the cursor', async () => {
    let page = 0
    const { calls } = mockFetch({
      'GET /api/v2/bills': () => (page++ === 0
        ? { success: true, bills: [row(1), row(2, { status: 'cancelled', cancel_kind: 'manual', gst: { tax: 0, taxable: 0, label: '-' } })], next_cursor: '2026-10-06 11:00|b2', range: { from: '2026-10-04', to: '2026-10-06' } }
        : { success: true, bills: [row(3, { invoice_type: 'B2B' })], next_cursor: null, range: { from: '2026-10-04', to: '2026-10-06' } }),
      'GET /api/v2/bills/summary': summary,
    })
    renderWith(<BillsPage />)
    expect((await screen.findAllByText('CC/2026/10/00001')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0)
    expect(await screen.findByText('GST collected')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect((await screen.findAllByText('CC/2026/10/00003')).length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.url.startsWith('/api/v2/bills?')).pop()!.url).toContain('cursor=2026-10-06+11%3A00%7Cb2')
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('debounces search into the query', async () => {
    const { calls } = mockFetch({
      'GET /api/v2/bills': { success: true, bills: [], next_cursor: null, range: { from: '2026-10-04', to: '2026-10-06' } },
      'GET /api/v2/bills/summary': summary,
    })
    renderWith(<BillsPage />)
    await screen.findByText('No bills in this range')
    await userEvent.type(screen.getByLabelText('Search bills'), 'ravi')
    await waitFor(() => expect(calls.some((c) => c.url.includes('q=ravi'))).toBe(true))
  })

  it('managers cannot pick a custom range', async () => {
    signIn('manager')
    mockFetch({ 'GET /api/v2/bills': { success: true, bills: [], next_cursor: null, range: { from: '2026-10-04', to: '2026-10-06' } }, 'GET /api/v2/bills/summary': summary })
    renderWith(<BillsPage />)
    await screen.findByText('No bills in this range')
    expect(screen.queryByRole('option', { name: 'Custom…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument()
  })
})

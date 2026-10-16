import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { mockFetch, renderWith, signIn } from '@/test/utils'
import { FinancePage } from './FinancePage'

const summary = { success: true, cash_total: 3000, online_total: 2000, addon_total: 100, refund_total: 200, expense_total: 500,
  transaction_expense_total: 300, report_expense_total: 200, total_revenue: 4500, renewals: 1, checkins: 3,
  cash_logs: [{ amount: 3000, date: '2026-10-06', method: 'cash' }], online_logs: [{ amount: 2000, date: '2026-10-05', method: 'online' }],
  addon_logs: [], refund_logs: [{ amount: 200, date: '2026-10-06' }], renewal_logs: [], expense_logs: [{ amount: 500, date: '2026-10-06', category: 'utilities' }] }
const revenue = { success: true, summary: { total_bills: 4, total_billed: 5200, hotel_revenue: 5200, ota_revenue: 0, total_services: 100, total_discounts: 0, total_balance_due: 0, invoices_issued: 4 },
  bills: [{ room: '201', total_amount: 2400 }, { room: '205', total_amount: 2800 }] }
const gstr1 = { success: true, b2b: [{ bill_number: 'CC/2026/10/00001', invoice_date: '2026-10-06', recipient_gstin: '29ABCDE1234F1Z5', recipient_name: 'Acme', place_of_supply: 'Karnataka (29)', gst_rate: 5, taxable: 1000, cgst: 25, sgst: 25, igst: 0, invoice_value: 1050, status: 'LIVE' }],
  b2cl: [], b2cs: [], cancelled_documents: [], documents: { listed: 1, cancelled: 0, net_live: 1 },
  rate_summary: { '5': { taxable: 1000, cgst: 25, sgst: 25, igst: 0 } }, hsn_summary: [], ota_commission_itc: 0, ota_commission_count: 0,
  totals: { taxable: 1000, cgst: 25, sgst: 25, igst: 0, invoice_value: 1050, invoices: 1 } }

describe('FinancePage', () => {
  it('admin overview shows KPIs from the report endpoints', async () => {
    signIn('admin')
    mockFetch({ 'GET /api/v2/reports/summary': summary, 'GET /api/v2/reports/revenue': revenue,
      'GET /api/v2/reports/insights': { success: true, insights: [{ level: 'good', text: 'Best day was Monday' }], totals: { avg_occupancy_pct: 61 } } })
    renderWith(<FinancePage />)
    expect(await screen.findByText('₹5,000')).toBeInTheDocument()       // collected
    expect(screen.getByText('₹4,500')).toBeInTheDocument()              // net
    expect(await screen.findByText('Best day was Monday')).toBeInTheDocument()
    expect(screen.getByText(/Avg occupancy 61%/)).toBeInTheDocument()
  })

  it('GST tab lists B2B invoices', async () => {
    signIn('admin')
    mockFetch({ 'GET /api/v2/reports/summary': summary, 'GET /api/v2/reports/revenue': revenue, 'GET /api/v2/reports/insights': { insights: [], totals: {} }, 'GET /api/v2/reports/gstr1': gstr1 })
    renderWith(<FinancePage />)
    await userEvent.click(screen.getByRole('tab', { name: 'GST (GSTR-1)' }))
    expect(await screen.findByText('29ABCDE1234F1Z5')).toBeInTheDocument()
    expect(screen.getByText('B2B invoices (1)')).toBeInTheDocument()
  })

  it('manager sees only operational tabs, transactions by default', async () => {
    signIn('manager')
    mockFetch({ 'GET /api/v2/transactions': { success: true, logs: { cash: [{ room: '201', name: 'Ravi', amount: 500, method: 'cash', type: 'checkin', date: '2026-10-06', time: '10:00' }], online: [], refunds: [], settlements: [], expenses: [{ _doc_id: 'e1', amount: 100, date: '2026-10-06', category: 'petty_cash', description: 'Tea', expense_type: 'transaction' }] } } })
    renderWith(<FinancePage />)
    expect(screen.queryByRole('tab', { name: 'Overview' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Finance' })).toBeInTheDocument()
    expect(await screen.findByText(/Room 201 · Ravi/)).toBeInTheDocument()
    expect(screen.getByText('Tea')).toBeInTheDocument()
  })

  it('settle later: lists pending and collects', async () => {
    signIn('manager')
    const { calls } = mockFetch({
      'GET /api/v2/transactions': { success: true, logs: { cash: [], online: [], refunds: [], settlements: [], expenses: [] } },
      'GET /api/v2/settlements': { success: true, count: 1, total_due: 400, settlements: [{ id: 's1', guest_name: 'Vinod', guest_mobile: '9876500020', room: '26', amount: 400, checkout_date: '2026-10-06', status: 'pending', notes: 'pays friday' }] },
      'POST /api/v2/settlements/s1/collect': { success: true, message: 'Collected' },
    })
    renderWith(<FinancePage />)
    await userEvent.click(screen.getByRole('tab', { name: 'Settle later' }))
    expect(await screen.findByText(/pays friday/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Collect' }))
    const dlg = await screen.findByRole('dialog')
    await userEvent.click(within(dlg).getByRole('button', { name: /Collect ₹400/ }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ payment_mode: 'cash', payment_amount: 400 }))
  })
})

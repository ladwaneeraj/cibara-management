import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { json, mockFetch, renderWith, signIn } from '@/test/utils'
import { BillDrawer } from './BillDrawer'

const bill = { success: true, bill: { id: 'b1', bill_number: 'CC/2026/10/00001', status: 'completed', guest_name: 'Ravi', guest_mobile: '9876543210',
  room: '201', checkin_time: '2026-10-05 12:00', checkout_time: '2026-10-06 11:00', days_stayed: 1, total_amount: 1240, balance: 0,
  payment_cash: 1240, payment_online: 0, invoice_type: 'B2C',
  tax_breakup: { rows: [{ hsn: '996311', description: 'Accommodation', rate: 5, taxable: 1142.86, cgst: 28.57, sgst: 28.57, igst: 0, tax: 57.14 }], taxable: 1142.86, tax: 57.14, cgst: 28.57, sgst: 28.57 } } }
const html = { success: true, html: '<div class="b-bill-wrap"><script>alert(1)</script>INVOICE BODY</div>', view: 'consolidated', collapsible: true }

describe('BillDrawer', () => {
  beforeEach(() => signIn('admin'))

  it('renders totals, tax rows and a sandboxed preview', async () => {
    mockFetch({ 'GET /api/v2/bills/b1': bill, 'GET /api/v2/bills/b1/html': html })
    renderWith(<BillDrawer billId="b1" onClose={() => {}} />)
    expect((await screen.findAllByText('₹1,240')).length).toBeGreaterThan(0)
    expect(screen.getByText('₹57.14')).toBeInTheDocument()
    const frame = await screen.findByTitle('Invoice CC/2026/10/00001')
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin allow-modals') // no allow-scripts
    expect(frame.getAttribute('srcdoc')).toContain('INVOICE BODY')
    expect(screen.getByRole('radio', { name: 'Day by day' })).toBeInTheDocument()
  })

  it('edits guest details', async () => {
    const { calls } = mockFetch({ 'GET /api/v2/bills/b1': bill, 'GET /api/v2/bills/b1/html': html, 'PATCH /api/v2/bills/b1/guest': { success: true, message: 'Guest details updated' } })
    renderWith(<BillDrawer billId="b1" onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /Ravi · 9876543210/ }))
    const dlg = (await screen.findAllByRole('dialog')).pop()!
    const name = within(dlg).getByLabelText('Guest name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Ravi K')
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ guest_name: 'Ravi K', guest_mobile: '9876543210' }))
  })

  it('cancel shows recorded receipts and requires removal', async () => {
    let n = 0
    const { calls } = mockFetch({
      'GET /api/v2/bills/b1': bill, 'GET /api/v2/bills/b1/html': html,
      'POST /api/v2/bills/b1/cancel': () => (n++ === 0
        ? json({ success: false, code: 'HAS_RECEIPTS', message: 'Money was received', receipt_entries: [{ method: 'cash', amount: 1240, date: '2026-10-06', time: '11:00' }], can_remove_receipts: true }, 409)
        : { success: true, message: 'Bill cancelled' }),
    })
    renderWith(<BillDrawer billId="b1" onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: /Cancel bill/ }))
    const dlg = (await screen.findAllByRole('dialog')).pop()!
    await userEvent.type(within(dlg).getByLabelText(/Reason/), 'Duplicate room entry')
    await userEvent.click(within(dlg).getByRole('checkbox', { name: /cannot be undone/ }))
    await userEvent.click(within(dlg).getByRole('button', { name: 'Cancel bill' }))
    expect(await within(dlg).findByText(/Money was recorded/)).toBeInTheDocument()
    expect(within(dlg).getByRole('button', { name: 'Cancel bill' })).toBeDisabled()
    await userEvent.click(within(dlg).getByRole('checkbox', { name: /No money was actually received/ }))
    await userEvent.click(within(dlg).getByRole('button', { name: 'Cancel bill' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').pop()?.body).toEqual({ reason: 'Duplicate room entry', confirm: true, remove_receipts: true }))
  })

  it('managers do not see cancel or collect', async () => {
    signIn('manager')
    mockFetch({ 'GET /api/v2/bills/b1': { ...bill, bill: { ...bill.bill, balance: 100 } }, 'GET /api/v2/bills/b1/html': html })
    renderWith(<BillDrawer billId="b1" onClose={() => {}} />)
    await screen.findByText('Balance due')
    expect(screen.queryByRole('button', { name: /Cancel bill/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Collect/ })).not.toBeInTheDocument()
  })
})

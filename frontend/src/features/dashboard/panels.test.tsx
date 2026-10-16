import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { ConfirmHost } from '@/components/layout/Overlays'
import type { Room } from '@/lib/types'
import { mockFetch, renderWith, signIn } from '@/test/utils'
import { CleaningPanel } from './CleaningPanel'
import { OccupiedPanel } from './OccupiedPanel'

const occ = (over: Partial<Room> = {}): Room => ({
  id: '201', status: 'occupied', category: 'premium', checkin_time: '2026-10-06 10:00', balance: 700, renewal_count: 0,
  active_bill_id: 'stay1', guest: { name: 'Ravi Kumar', mobile: '9876543210', price: 1200, guests: 2, payment: 'cash' },
  _renewal: { day: 1, due: false, next_renewal: '2026-10-07 10:00', minutes_left: 600 }, _mmt_prepaid: false, ...over,
})
const history = { success: true, cash: [{ room: '201', name: 'Ravi', amount: 500, method: 'cash', type: 'checkin', date: '2026-10-06', time: '10:00' }],
  online: [], refunds: [], addons: [{ room: '201', name: 'Ravi', amount: 40, method: 'balance', type: 'addon', item: 'Water 1L', quantity: 2, date: '2026-10-06', time: '11:00' }], renewals: [], shifts: [] }
const base = { 'GET /api/v2/rooms/201/history': history, 'GET /api/v2/dashboard': { success: true, rooms: [], stats: {}, upcoming: {}, ui_config: {} },
  'GET /api/v2/rooms/tariffs': { tariffs: {} } }

describe('OccupiedPanel', () => {
  beforeEach(() => signIn('manager'))

  it('shows the stay and collects a payment', async () => {
    const { calls } = mockFetch({ ...base, 'POST /api/v2/rooms/201/payment': { success: true, message: 'Payment recorded' } })
    renderWith(<OccupiedPanel room={occ()} onDone={() => {}} />)
    expect(await screen.findByText('Water 1L × 2')).toBeInTheDocument()
    expect(screen.getByText('Paid at check-in')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'UPI' }))
    await userEvent.click(screen.getByRole('button', { name: /Receive ₹700/ }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ amount: 700, mode: 'online' }))
  })

  it('offers a refund when the guest is in credit', async () => {
    const { calls } = mockFetch({ ...base, 'POST /api/v2/rooms/201/refund': { success: true, message: 'Refunded' } })
    renderWith(<OccupiedPanel room={occ({ balance: -200 })} onDone={() => {}} />)
    const amt = screen.getByLabelText('Amount')
    await userEvent.type(amt, '200')
    await userEvent.click(screen.getByRole('button', { name: /Refund ₹200/ }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v2/rooms/201/refund')).toBe(true))
  })

  it('adds a quick service through the dialog', async () => {
    const { calls } = mockFetch({ ...base, 'POST /api/v2/rooms/201/addons': { success: true, message: 'Added' } })
    renderWith(<OccupiedPanel room={occ()} onDone={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /Water 2L/ }))
    const dlg = await screen.findByRole('dialog')
    await userEvent.tripleClick(within(dlg).getByLabelText('Quantity'))
    await userEvent.keyboard('3')
    await userEvent.click(within(dlg).getByRole('button', { name: /Add ₹90/ }))
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/addons'))?.body).toMatchObject({ item: 'Water 2L', unit_price: 30, quantity: 3, payment_method: 'balance', accommodation_charge: false }))
  })

  it('blocks checkout with a balance and lets an admin settle later', async () => {
    mockFetch({ ...base })
    renderWith(<OccupiedPanel room={occ()} onDone={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Check out' }))
    const dlg = await screen.findByRole('dialog')
    expect(within(dlg).getByText(/Collect ₹700 first/)).toBeInTheDocument()
    expect(within(dlg).getByRole('button', { name: 'Yes, check out' })).toBeDisabled()
    expect(within(dlg).queryByText(/Settle later/)).not.toBeInTheDocument() // manager
  })

  it('admin settle-later checkout posts the flag and notes', async () => {
    signIn('admin')
    const { calls } = mockFetch({ ...base, 'POST /api/v2/rooms/201/checkout': { success: true, message: 'Checkout successful', bill_id: 'b1', has_bill: true } })
    renderWith(<><OccupiedPanel room={occ()} onDone={() => {}} /><ConfirmHost /></>)
    await userEvent.click(screen.getByRole('button', { name: 'Check out' }))
    const dlg = await screen.findByRole('dialog')
    await userEvent.click(within(dlg).getByRole('switch'))
    await userEvent.type(within(dlg).getByPlaceholderText('Notes for the settlement'), 'pays friday')
    await userEvent.click(within(dlg).getByRole('button', { name: 'Yes, check out' }))
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/checkout'))?.body).toEqual({ settle_later: true, settlement_notes: 'pays friday' }))
    expect(await screen.findByText(/Open the bill/)).toBeInTheDocument()
  })

  it('hides money actions for prepaid OTA stays', () => {
    mockFetch({ ...base })
    renderWith(<OccupiedPanel room={occ({ balance: 0, guest: { ...occ().guest!, payment: 'ota' } })} onDone={() => {}} />)
    expect(screen.getByText(/Prepaid through the OTA/)).toBeInTheDocument()
    expect(screen.queryByText('Collect payment')).not.toBeInTheDocument()
  })
})

const cleaning = (over: Partial<Room> = {}): Room => ({
  id: '210', status: 'cleaning', category: 'regular', guest: null, checkin_time: null, balance: 0, cleaning_status: 'in_progress',
  cleaning_start_time: '2026-10-06 11:00:00', _renewal: { day: 0, due: false, next_renewal: null, minutes_left: null }, _mmt_prepaid: false, ...over,
})

describe('CleaningPanel', () => {
  it('housekeeping marks a room cleaned', async () => {
    signIn('housekeeping')
    const { calls } = mockFetch({ 'POST /api/v2/rooms/210/cleaned': { success: true, message: 'Room 210 cleaned.' } })
    renderWith(<CleaningPanel room={cleaning()} uiConfig={{}} onDone={() => {}} />)
    expect(screen.queryByText('Inspection checklist')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Mark as cleaned' }))
    await waitFor(() => expect(calls[0].url).toBe('/api/v2/rooms/210/cleaned'))
  })

  it('manager must add photos before release when the switch is on', () => {
    signIn('manager')
    mockFetch({})
    renderWith(<CleaningPanel room={cleaning({ cleaning_status: 'ready_to_inspect' })} uiConfig={{ inspection_photos: true }} onDone={() => {}} />)
    expect(screen.getByText('Inspection checklist')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ready for next guest' })).toBeDisabled()
    expect(screen.getByText(/Add washroom, room \/ bed photos to continue/)).toBeInTheDocument()
  })

  it('manager releases a non-photo room with the checklist', async () => {
    signIn('manager')
    const { calls } = mockFetch({ 'POST /api/v2/rooms/5/ready': { success: true, message: 'Room 5 is ready' } })
    renderWith(<CleaningPanel room={cleaning({ id: '5', cleaning_status: 'ready_to_inspect' })} uiConfig={{ inspection_photos: true }} onDone={() => {}} />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Room ready' }))
    await userEvent.click(screen.getByRole('button', { name: 'Ready for next guest' }))
    await waitFor(() => expect(calls[0].body).toEqual({ checklist: { room_ready: true } }))
  })
})

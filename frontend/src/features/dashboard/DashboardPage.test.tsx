import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { mockFetch, renderWith, signIn } from '@/test/utils'
import { DashboardPage } from './DashboardPage'

const r = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'vacant', category: Number(id) >= 200 && Number(id) <= 206 ? 'premium' : 'regular', guest: null,
  checkin_time: null, balance: 0, renewal_count: 0, _renewal: { day: 0, due: false, next_renewal: null, minutes_left: null },
  _mmt_prepaid: false, ...over,
})
const occupied = r('203', {
  status: 'occupied', balance: 500, active_bill_id: 'stay1', checkin_time: '2026-10-06 10:00',
  guest: { name: 'Ravi Kumar', mobile: '9876543210', price: 1200, guests: 2, payment: 'cash', isAC: true },
  _renewal: { day: 2, due: true, next_renewal: '2026-10-07 10:00', minutes_left: -3 },
})
const dashboard = {
  success: true, server_time: '2026-10-06 12:00:00', today: '2026-10-06',
  rooms: [r('1'), r('201'), occupied, r('210', { status: 'cleaning', cleaning_status: 'ready_to_inspect', cleaning_start_time: '2026-10-06 11:00:00' })],
  stats: { vacant: 2, occupied: 1, cleaning: 1, balances_total: 500, balances_count: 1, renewals_due: 1, total: 4 },
  upcoming: { '201': { booking_id: 'b', guest_name: 'Arriving Guest', check_in_date: '2026-10-06', check_in_time: '14:00', hours_until: 2, status: 'confirmed' } },
  ui_config: { inspection_photos: true },
  today_summary: { cash: 1000, online: 500, refunds: 0, expenses: 200, net: 1500, checkins: 2, transactions: 3 },
  totals: {},
}
const tariffs = { tariffs: { '1': { category: 'single-non-attach', default_guests: 1, prices: { 1: 250, 2: 250 }, ac_surcharge: 0 },
  '201': { category: 'premium', default_guests: 2, prices: { 1: 1200, 2: 1200, 3: 1500 }, ac_surcharge: 600 } } }

describe('DashboardPage', () => {
  beforeEach(() => signIn('admin'))

  it('renders stats, room cards and renewal state', async () => {
    mockFetch({ 'GET /api/v2/dashboard': dashboard, 'GET /api/v2/rooms/tariffs': tariffs })
    renderWith(<DashboardPage />)
    const card = await screen.findByRole('button', { name: /Room 203, occupied, Ravi Kumar/ })
    expect(within(card).getByText('Renewal due')).toBeInTheDocument()
    expect(within(card).getByText('D2')).toBeInTheDocument()
    expect(within(card).getByText('₹500')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Room 210, ready to inspect/ })).toBeInTheDocument()
    expect(screen.getByText('Collected today')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Renew 1 due/ })).toBeInTheDocument()
  })

  it('filters to balances', async () => {
    mockFetch({ 'GET /api/v2/dashboard': dashboard })
    renderWith(<DashboardPage />)
    await screen.findByRole('button', { name: /Room 203/ })
    await userEvent.click(screen.getByRole('radio', { name: /balances/i }))
    expect(screen.queryByRole('button', { name: /Room 201,/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Room 203,/ })).toBeInTheDocument()
  })

  it('checks a guest in with the server tariff and posts the typed payload', async () => {
    const { calls } = mockFetch({
      'GET /api/v2/dashboard': dashboard, 'GET /api/v2/rooms/tariffs': tariffs,
      'GET /api/v2/customers/lookup': { success: false, message: 'Customer not found' },
      'POST /api/v2/rooms/201/checkin': { success: true, message: 'Check-in successful for Anil (#4)', serial_number: 4 },
    })
    renderWith(<DashboardPage />)
    await userEvent.click(await screen.findByRole('button', { name: /Room 201, vacant/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/Arriving Guest/)).toBeInTheDocument()
    await waitFor(() => expect(within(dialog).getByLabelText('Price / night')).toHaveValue(1200))
    await userEvent.click(within(dialog).getByRole('switch'))
    await waitFor(() => expect(within(dialog).getByLabelText('Price / night')).toHaveValue(1800))
    await userEvent.type(within(dialog).getByLabelText('Mobile'), '9123456789')
    await userEvent.type(within(dialog).getByLabelText('Guest name'), 'Anil')
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Pay later' }))
    expect(within(dialog).getByLabelText('Amount paid now')).toHaveValue(0)
    await userEvent.click(within(dialog).getByRole('button', { name: /Check in to room 201/ }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body).toMatchObject({ name: 'Anil', mobile: '9123456789', guests: 2, price: 1800, amount_paid: 0, payment: 'balance', is_ac: true })
    expect(post.headers['X-Op-Id']).toBeTruthy()
  })

  it('housekeeping lands on the cleaning filter and sees no money', async () => {
    signIn('housekeeping')
    const { today_summary: _t, totals: _x, ...hk } = dashboard
    mockFetch({ 'GET /api/v2/dashboard': hk })
    renderWith(<DashboardPage />)
    expect(await screen.findByRole('heading', { name: 'Housekeeping' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Room 210,/ })).toBeInTheDocument()
    expect(screen.queryByText('Balances due')).not.toBeInTheDocument()
    expect(screen.queryByText('Collected today')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Room 201,/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Room 210,/ })).toBeInTheDocument()
  })
})

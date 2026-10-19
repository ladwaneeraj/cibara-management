import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { json, mockFetch, renderWith, signIn } from '@/test/utils'
import { Customers } from '../sections/Customers'
import { CUSTOMERS } from './fixtures'

describe('Customers section', () => {
  it('shows KPI tiles, RFM segments, the acquisition trend and top guests', async () => {
    signIn('admin')
    mockFetch({ 'GET /customer_insights': CUSTOMERS })
    renderWith(<Customers />)
    expect(await screen.findByText('Guest base')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Guest base & loyalty' })).toBeInTheDocument()

    const tile = (label: string) => screen.getByText(label).closest('.card') as HTMLElement
    expect(within(tile('Guest base')).getByText('1,200')).toBeInTheDocument()
    expect(within(tile('Repeat rate')).getByText('25%')).toBeInTheDocument()
    expect(within(tile('Lifetime revenue')).getByText('₹48,00,000')).toBeInTheDocument()
    expect(within(tile('Avg spend per guest')).getByText('₹4,000')).toBeInTheDocument()
    expect(within(tile('Avg spend per guest')).getByText(/1\.6 stays/)).toBeInTheDocument()
    expect(within(tile('Outstanding dues')).getByText('₹18,500')).toBeInTheDocument()
    expect(within(tile('Outstanding dues')).getByText(/6 guests/)).toBeInTheDocument()
    expect(within(tile('Top 10% of guests')).getByText('38%')).toBeInTheDocument()
    expect(within(tile('Top 10% of guests')).getByText(/top 20%: 55%/i)).toBeInTheDocument()

    for (const label of ['New', 'Returning', 'Loyal', '₹5k–15k', 'Cooling', 'Lost']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument()
    }
    expect(screen.getByTestId('acquisition-chart')).toBeInTheDocument()

    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.getByText('₹52,000')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Most stays' }))
    expect(screen.getByText('Meera Iyer')).toBeInTheDocument()
  })

  it('is hidden entirely when the viewer lacks customer.manage (403)', async () => {
    signIn('admin')
    const { calls } = mockFetch({ 'GET /customer_insights': () => json({ success: false, message: 'Permission denied' }, 403) })
    const { container } = renderWith(<Customers />)
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Guest base & loyalty' })).not.toBeInTheDocument())
    expect(container).toBeEmptyDOMElement()
  })

  it('a non-403 failure shows an error with retry, not a blank gap', async () => {
    signIn('admin')
    mockFetch({ 'GET /customer_insights': () => json({ success: false, message: 'boom' }, 500) })
    renderWith(<Customers />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom|server error/i)
    expect(screen.getByRole('heading', { name: 'Guest base & loyalty' })).toBeInTheDocument()
  })

  it('clicking a segment drills through to the guests in it', async () => {
    signIn('admin')
    const { calls } = mockFetch({
      'GET /customer_insights': CUSTOMERS,
      'GET /customer_segment': {
        success: true, count: 1,
        customers: [{ name: 'Rohan Das', mobile: '9111111111', total_stays: 3, total_spent: 12000, last_stay_date: '2026-09-30', is_flagged: false }],
      },
    })
    renderWith(<Customers />)
    await userEvent.click(await screen.findByRole('button', { name: /Returning/ }))
    expect(await screen.findByText('Rohan Das')).toBeInTheDocument()
    const call = calls.find((c) => c.url.startsWith('/customer_segment'))!
    const u = new URL(call.url, 'http://x')
    expect(u.searchParams.get('dimension')).toBe('loyalty')
    expect(u.searchParams.get('key')).toBe('1')
    expect(screen.getByText('₹12,000')).toBeInTheDocument()
    // clicking again closes it
    await userEvent.click(screen.getByRole('button', { name: /Returning/ }))
    await waitFor(() => expect(screen.queryByText('Rohan Das')).not.toBeInTheDocument())
  })
})

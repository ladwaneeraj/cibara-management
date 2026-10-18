import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Overview } from '../sections/Overview'
import { RangePicker } from '../RangePicker'
import { rangeFor } from '../range'
import { OVERVIEW } from './fixtures'

describe('Overview KPI strip', () => {
  it('shows occupancy, ADR, RevPAR, net revenue and next-7 on-books, formatted', () => {
    render(<Overview data={OVERVIEW} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toBeInTheDocument()
    const tile = (label: string) => screen.getByText(label).closest('.card') as HTMLElement
    expect(within(tile('Occupancy')).getByText('62.5%')).toBeInTheDocument()
    expect(within(tile('Occupancy')).getByText(/87 of 140 room-nights/)).toBeInTheDocument()
    expect(within(tile('ADR')).getByText('₹2,100')).toBeInTheDocument()
    expect(within(tile('RevPAR')).getByText('₹1,313')).toBeInTheDocument()
    expect(within(tile('Net revenue')).getByText('₹1,49,000')).toBeInTheDocument()
    expect(within(tile('Collections')).getByText('₹1,55,000')).toBeInTheDocument()
    expect(within(tile('On the books, next 7 nights')).getByText('48.2%')).toBeInTheDocument()
    expect(within(tile('On the books, next 7 nights')).getByText(/₹62,400/)).toBeInTheDocument()
  })

  it('names the window it covers', () => {
    render(<Overview data={OVERVIEW} />)
    expect(screen.getByText(/12 Oct/)).toBeInTheDocument()
    expect(screen.getByText(/7 days/)).toBeInTheDocument()
  })

  it('a zero-occupancy window renders zeros, not NaN', () => {
    const empty = structuredClone(OVERVIEW)
    empty.overview.occupancy = { ...empty.overview.occupancy, occupancy_pct: 0, adr: 0, revpar: 0, occupied_room_nights: 0 }
    render(<Overview data={empty} />)
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/NaN/)
  })
})

describe('rangeFor', () => {
  it('computes IST presets from a given today', () => {
    expect(rangeFor('today', '2026-10-18')).toEqual({ preset: 'today', from: '2026-10-18', to: '2026-10-18' })
    expect(rangeFor('7d', '2026-10-18')).toEqual({ preset: '7d', from: '2026-10-12', to: '2026-10-18' })
    expect(rangeFor('30d', '2026-10-18')).toEqual({ preset: '30d', from: '2026-09-19', to: '2026-10-18' })
    expect(rangeFor('month', '2026-10-18')).toEqual({ preset: 'month', from: '2026-10-01', to: '2026-10-18' })
  })
})

describe('RangePicker', () => {
  const value = rangeFor('7d', '2026-10-18')

  it('picking a preset emits that range', async () => {
    const onChange = vi.fn()
    render(<RangePicker value={value} onChange={onChange} today="2026-10-18" />)
    expect(screen.getByRole('radio', { name: 'Last 7 days' })).toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: 'Today' }))
    expect(onChange).toHaveBeenCalledWith({ preset: 'today', from: '2026-10-18', to: '2026-10-18' })
    await userEvent.click(screen.getByRole('radio', { name: 'This month' }))
    expect(onChange).toHaveBeenLastCalledWith({ preset: 'month', from: '2026-10-01', to: '2026-10-18' })
  })

  it('custom shows two date inputs and emits edits', () => {
    const onChange = vi.fn()
    render(<RangePicker value={{ preset: 'custom', from: '2026-10-01', to: '2026-10-10' }} onChange={onChange} today="2026-10-18" />)
    const from = screen.getByLabelText('From') as HTMLInputElement
    const to = screen.getByLabelText('To') as HTMLInputElement
    expect(from.value).toBe('2026-10-01')
    expect(to.value).toBe('2026-10-10')
    fireEvent.change(to, { target: { value: '2026-10-12' } })
    expect(onChange).toHaveBeenLastCalledWith({ preset: 'custom', from: '2026-10-01', to: '2026-10-12' })
  })

  it('never lets the end date precede the start (ignored until valid)', () => {
    const onChange = vi.fn()
    render(<RangePicker value={{ preset: 'custom', from: '2026-10-05', to: '2026-10-10' }} onChange={onChange} today="2026-10-18" />)
    const to = screen.getByLabelText('To') as HTMLInputElement
    fireEvent.change(to, { target: { value: '2026-10-01' } })
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ to: '2026-10-01' }))
  })
})

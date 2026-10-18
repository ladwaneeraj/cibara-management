import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BookingPace } from '../sections/BookingPace'
import { OVERVIEW } from './fixtures'

describe('BookingPace', () => {
  it('shows forward occupancy and on-books revenue for 7 / 14 / 30 nights', () => {
    render(<BookingPace data={OVERVIEW.pace} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Booking pace' })).toBeInTheDocument()
    const tile = (label: string) => screen.getByText(label).closest('[data-horizon]') as HTMLElement

    const n7 = within(tile('Next 7 nights'))
    expect(n7.getByText('47.9%')).toBeInTheDocument()
    expect(n7.getByText(/₹62,400/)).toBeInTheDocument()
    expect(n7.getByText(/67 of 140 room-nights/)).toBeInTheDocument()

    expect(within(tile('Next 14 nights')).getByText('35.7%')).toBeInTheDocument()
    expect(within(tile('Next 14 nights')).getByText(/₹91,000/)).toBeInTheDocument()
    expect(within(tile('Next 30 nights')).getByText('25%')).toBeInTheDocument()
    expect(within(tile('Next 30 nights')).getByText(/₹1,40,000/)).toBeInTheDocument()
  })

  it('renders the pace-vs-prior delta when present and hides it when null', () => {
    render(<BookingPace data={OVERVIEW.pace} />)
    const n7 = within(screen.getByText('Next 7 nights').closest('[data-horizon]') as HTMLElement)
    expect(n7.getByText(/\+5\.2 pts/)).toBeInTheDocument()
    expect(n7.getByText(/\+₹8,000/)).toBeInTheDocument()
    expect(n7.getByText(/vs last week/)).toBeInTheDocument()
    // 14 and 30 have delta: null — nothing rendered, not "0" or "NaN"
    for (const label of ['Next 14 nights', 'Next 30 nights']) {
      const t = within(screen.getByText(label).closest('[data-horizon]') as HTMLElement)
      expect(t.queryByText(/vs last week/)).not.toBeInTheDocument()
    }
    expect(screen.getAllByText(/vs last week/)).toHaveLength(1)
    expect(screen.getByText(/builds up as nightly snapshots accumulate/i)).toBeInTheDocument()
  })

  it('shows a negative delta distinctly', () => {
    const pace = structuredClone(OVERVIEW.pace)
    pace.horizons['7']!.delta = { occupancy_pct: -3, on_books_revenue: -1500 }
    render(<BookingPace data={pace} />)
    expect(screen.getByText(/-3 pts/)).toBeInTheDocument()
    expect(screen.getByText(/-₹1,500/)).toBeInTheDocument()
  })

  it('accepts a bare numeric delta (occupancy points)', () => {
    const pace = structuredClone(OVERVIEW.pace)
    pace.horizons['7']!.delta = 4
    render(<BookingPace data={pace} />)
    expect(screen.getByText(/\+4 pts/)).toBeInTheDocument()
  })

  it('explains the missing comparison when no snapshot exists yet', () => {
    const pace = structuredClone(OVERVIEW.pace)
    for (const h of Object.values(pace.horizons)) h!.delta = null
    render(<BookingPace data={pace} />)
    expect(screen.queryByText(/vs last week/)).not.toBeInTheDocument()
    expect(screen.getByText(/builds up as nightly snapshots accumulate/i)).toBeInTheDocument()
  })

  it('tolerates a missing horizon', () => {
    render(<BookingPace data={{ horizons: { '7': OVERVIEW.pace.horizons['7'] } }} />)
    expect(screen.getByText('Next 7 nights')).toBeInTheDocument()
    expect(screen.queryByText('Next 14 nights')).not.toBeInTheDocument()
  })
})

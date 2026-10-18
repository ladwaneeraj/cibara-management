import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { cloneElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Seasonality } from '../sections/Seasonality'
import { OVERVIEW } from './fixtures'

// jsdom has no layout, so ResponsiveContainer renders nothing. Give it a size.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children, height }: { children: ReactElement; height: number }) => (
      <div style={{ width: 800, height }}>{cloneElement(children, { width: 800, height } as object)}</div>
    ),
  }
})

const line = (re: RegExp) => screen.getByText(re).closest('p') as HTMLElement

describe('Seasonality', () => {
  it('draws 7 weekday bars and a 12-month series', () => {
    const { container } = render(<Seasonality data={OVERVIEW.seasonality} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Seasonality' })).toBeInTheDocument()
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(7)
    const monthChart = screen.getByTestId('month-chart')
    expect(monthChart.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick')).toHaveLength(12)
    expect(monthChart.querySelectorAll('.recharts-line')).toHaveLength(1)
  })

  it('names the strongest and softest weekday and month for the metric', () => {
    render(<Seasonality data={OVERVIEW.seasonality} />)
    // fixture: occupancy rises Mon→Sun, Jan→Dec
    expect(line(/Strongest weekday/)).toHaveTextContent('Sunday (88%)')
    expect(line(/Softest weekday/)).toHaveTextContent('Monday (40%)')
    expect(line(/Strongest month/)).toHaveTextContent("Dec '26 (74%)")
    expect(line(/Softest month/)).toHaveTextContent("Jan '26 (30%)")
  })

  it('switches between occupancy, ADR and RevPAR', async () => {
    render(<Seasonality data={OVERVIEW.seasonality} />)
    expect(screen.getByRole('radio', { name: 'Occupancy' })).toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: 'ADR' }))
    expect(screen.getByRole('radio', { name: 'ADR' })).toBeChecked()
    expect(line(/Strongest weekday/)).toHaveTextContent('Sunday (₹2,100)')
    await userEvent.click(screen.getByRole('radio', { name: 'RevPAR' }))
    expect(line(/Softest weekday/)).toHaveTextContent('Monday (₹700)')
  })

  it('shows an empty state with no data', () => {
    render(<Seasonality data={{ weekday: [], months: [] }} />)
    expect(screen.getByText(/not enough history/i)).toBeInTheDocument()
  })
})

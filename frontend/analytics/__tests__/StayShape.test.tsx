import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { cloneElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { StayShape } from '../sections/StayShape'
import { OVERVIEW } from './fixtures'

vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children, height }: { children: ReactElement; height: number }) => (
      <div style={{ width: 800, height }}>{cloneElement(children, { width: 800, height } as object)}</div>
    ),
  }
})

const fills = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('.recharts-bar-rectangle path')).map((p) => p.getAttribute('fill'))

describe('StayShape', () => {
  it('draws a length-of-stay histogram and a lead-time histogram', () => {
    render(<StayShape data={OVERVIEW.los_leadtime} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Length of stay & lead time' })).toBeInTheDocument()
    const los = screen.getByTestId('los-chart')
    const lead = screen.getByTestId('lead-chart')
    expect(los.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(5)
    expect(lead.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(5)
    for (const b of ['1', '2', '3', '4-6', '7+']) expect(los).toHaveTextContent(b)
  })

  it('shows walk-in as its own, differently coloured bucket', () => {
    render(<StayShape data={OVERVIEW.los_leadtime} />)
    const lead = screen.getByTestId('lead-chart')
    expect(lead).toHaveTextContent('walk-in')
    const f = fills(lead)
    expect(f).toHaveLength(5)
    const walkIn = f[0]
    expect(new Set(f.slice(1)).size).toBe(1)        // booked buckets share a colour
    expect(walkIn).not.toBe(f[1])                    // walk-in is visibly different
    expect(screen.getByText(/25 of 66 stays \(37\.9%\) were walk-ins/)).toBeInTheDocument()
  })

  it('handles an empty window without NaN', () => {
    render(<StayShape data={{ los: [], lead_time: [] }} />)
    expect(screen.getByText(/no stays/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/NaN/)
  })
})

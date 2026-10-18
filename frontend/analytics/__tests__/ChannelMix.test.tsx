import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChannelMix } from '../sections/ChannelMix'
import { OVERVIEW } from './fixtures'

describe('ChannelMix', () => {
  it('renders a row per channel with gross, commission, net, net ADR and share', () => {
    render(<ChannelMix data={OVERVIEW.channel_mix} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Channel mix' })).toBeInTheDocument()
    const row = (name: string) => screen.getByRole('cell', { name }).closest('tr') as HTMLElement

    const mmt = within(row('MMT'))
    expect(mmt.getByText('₹60,000')).toBeInTheDocument()   // gross
    expect(mmt.getByText('₹9,000')).toBeInTheDocument()    // commission
    expect(mmt.getByText('₹51,000')).toBeInTheDocument()   // net
    expect(mmt.getByText('₹1,700')).toBeInTheDocument()    // net ADR
    expect(mmt.getByText('33%')).toBeInTheDocument()       // share
    expect(mmt.getByText('30')).toBeInTheDocument()        // room-nights

    const direct = within(row('Direct/Walk-in'))
    expect(direct.getByText('49%')).toBeInTheDocument()
    expect(direct.getByText('—')).toBeInTheDocument()      // no commission
  })

  it('NET is emphasised and the footer totals gross and net', () => {
    render(<ChannelMix data={OVERVIEW.channel_mix} />)
    expect(screen.getByRole('columnheader', { name: 'Net' })).toBeInTheDocument()
    const foot = within(screen.getAllByRole('row').at(-1) as HTMLElement)
    expect(foot.getByText('Total')).toBeInTheDocument()
    expect(foot.getByText('₹1,83,750')).toBeInTheDocument()
    expect(foot.getByText('₹1,69,688')).toBeInTheDocument()
  })

  it('draws the channel chart block', () => {
    render(<ChannelMix data={OVERVIEW.channel_mix} />)
    expect(screen.getByTestId('channel-chart')).toBeInTheDocument()
  })

  it('shows an empty state when there are no stays', () => {
    render(<ChannelMix data={{ channels: [], total_gross: 0, total_net: 0 }} />)
    expect(screen.getByText(/no stays/i)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

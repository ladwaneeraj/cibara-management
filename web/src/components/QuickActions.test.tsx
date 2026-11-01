import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QuickActions } from './QuickActions'
import type { Booking } from '../types/booking'

function b(p: Partial<Booking>): Booking {
  return {
    booking_id: 'b1',
    room: '201',
    guest_name: 'Asha',
    guest_mobile: '9811111111',
    check_in_date: '2026-11-05',
    check_out_date: '2026-11-07',
    status: 'confirmed',
    booking_source: 'normal',
    total_amount: 1000,
    paid_amount: 0,
    balance: 1000,
    ...p,
  }
}

it('offers check-in, collect, cancel, whatsapp and edit for a confirmed walk-in with balance', () => {
  render(<QuickActions booking={b({})} onAction={() => {}} />)
  expect(screen.getByRole('button', { name: /Check-in/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Collect payment/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /WhatsApp/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Edit/ })).toBeInTheDocument()
})

it('hides Collect payment for an OTA prepaid booking', () => {
  render(<QuickActions booking={b({ booking_source: 'mmt' })} onAction={() => {}} />)
  expect(screen.queryByRole('button', { name: /Collect payment/ })).not.toBeInTheDocument()
})

it('offers no check-in or cancel once cancelled', () => {
  render(<QuickActions booking={b({ status: 'cancelled' })} onAction={() => {}} />)
  expect(screen.queryByRole('button', { name: /Check-in/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^Cancel/ })).not.toBeInTheDocument()
})

it('offers No-show for a confirmed booking and fires it', async () => {
  const onAction = vi.fn()
  render(<QuickActions booking={b({})} onAction={onAction} />)
  await userEvent.click(screen.getByRole('button', { name: /No-show/ }))
  expect(onAction).toHaveBeenCalledWith('noshow')
})

it('fires onAction with the kind', async () => {
  const onAction = vi.fn()
  render(<QuickActions booking={b({})} onAction={onAction} />)
  await userEvent.click(screen.getByRole('button', { name: /Check-in/ }))
  expect(onAction).toHaveBeenCalledWith('convert')
})

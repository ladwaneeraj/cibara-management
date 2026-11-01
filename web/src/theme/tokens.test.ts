import { statusColor, tokens } from './tokens'
import type { BookingStatus } from '../types/booking'

it('mirrors the classic primary token', () => {
  expect(tokens.primary).toBe('#4361ee')
  expect(tokens.fontFamily).toContain('Segoe UI')
})

it('maps every booking status to a hex color', () => {
  const statuses: BookingStatus[] = [
    'confirmed',
    'checked_in',
    'checked_out',
    'cancelled',
    'no_show',
  ]
  for (const s of statuses) {
    expect(statusColor[s]).toMatch(/^#[0-9a-f]{6}$/i)
  }
})

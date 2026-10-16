import { describe, expect, it } from 'vitest'
import { addDays, duration, initials, istDate, monthStart, money, stamp } from './format'

describe('format', () => {
  it('formats rupees in Indian grouping', () => {
    expect(money(123456)).toBe('₹1,23,456')
    expect(money(null)).toBe('₹0')
  })
  it('computes IST business dates', () => {
    // 2026-10-05 20:00 UTC is already 6 Oct in India
    expect(istDate(new Date('2026-10-05T20:00:00Z'))).toBe('2026-10-06')
    expect(istDate(new Date('2026-10-05T18:00:00Z'))).toBe('2026-10-05')
  })
  it('does date arithmetic on YYYY-MM-DD', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(monthStart('2026-10-06')).toBe('2026-10-01')
  })
  it('renders timestamps and durations', () => {
    expect(stamp('2026-10-06 14:05')).toBe('6 Oct, 2:05 pm')
    expect(stamp('2026-10-06 00:30')).toBe('6 Oct, 12:30 am')
    expect(stamp(null)).toBe('—')
    expect(duration(135)).toBe('2h 15m')
    expect(duration(9)).toBe('9m')
    expect(initials('ravi kumar sharma')).toBe('RK')
  })
})

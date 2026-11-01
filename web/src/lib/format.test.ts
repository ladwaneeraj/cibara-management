import { formatDate, formatMoney, formatTime, nights } from './format'

describe('formatTime (parity with booking.js)', () => {
  it('defaults an empty time to 2:00 PM', () => {
    expect(formatTime('')).toBe('2:00 PM')
    expect(formatTime(undefined)).toBe('2:00 PM')
  })
  it('converts 24h to 12h am/pm', () => {
    expect(formatTime('14:30')).toBe('2:30 PM')
    expect(formatTime('09:05')).toBe('9:05 AM')
    expect(formatTime('00:00')).toBe('12:00 AM')
    expect(formatTime('12:00')).toBe('12:00 PM')
  })
})

describe('formatMoney', () => {
  it('formats rupees with Indian grouping', () => {
    expect(formatMoney(1200)).toBe('₹1,200')
    expect(formatMoney(100000)).toBe('₹1,00,000')
  })
})

describe('nights', () => {
  it('counts days between check-in and check-out', () => {
    expect(nights('2026-11-05', '2026-11-07')).toBe(2)
    expect(nights('2026-11-05', '2026-11-05')).toBe(0)
  })
})

describe('formatDate', () => {
  it('renders a short weekday/day/month/year string', () => {
    // en-US short format, e.g. "Thu, Nov 5, 2026"
    expect(formatDate('2026-11-05')).toMatch(/Nov/)
    expect(formatDate('2026-11-05')).toMatch(/2026/)
  })
})

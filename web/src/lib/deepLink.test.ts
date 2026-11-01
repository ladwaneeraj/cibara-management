import { getDeepLinkBookingId } from './deepLink'

it('reads ?booking=<id> from a query string', () => {
  expect(getDeepLinkBookingId('?booking=abc123')).toBe('abc123')
  expect(getDeepLinkBookingId('?foo=1&booking=xyz')).toBe('xyz')
})

it('returns null when absent', () => {
  expect(getDeepLinkBookingId('')).toBeNull()
  expect(getDeepLinkBookingId('?foo=1')).toBeNull()
})

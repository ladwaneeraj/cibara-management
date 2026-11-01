import { buildWhatsappUrl, normalizePhone } from './whatsapp'

describe('normalizePhone (parity with booking.js)', () => {
  it('strips a leading 0 and prefixes 91', () => {
    expect(normalizePhone('09811111111')).toBe('919811111111')
    expect(normalizePhone('9811111111')).toBe('919811111111')
    expect(normalizePhone('919811111111')).toBe('919811111111')
    expect(normalizePhone('+91 98111-11111')).toBe('919811111111')
  })
})

describe('buildWhatsappUrl', () => {
  it('builds a wa.me link with encoded text', () => {
    const url = buildWhatsappUrl('9811111111', 'Hi there')
    expect(url).toContain('https://wa.me/919811111111')
    expect(url).toContain('text=Hi%20there')
  })
})

import { getGroupMembers, isOtaPrepaid, otaSourceLabel, paymentLabel, repeatGuestMobiles } from './booking'

describe('isOtaPrepaid', () => {
  it('is true for mmt and agoda only', () => {
    expect(isOtaPrepaid('mmt')).toBe(true)
    expect(isOtaPrepaid('agoda')).toBe(true)
    expect(isOtaPrepaid('normal')).toBe(false)
    expect(isOtaPrepaid(undefined)).toBe(false)
  })
})

describe('otaSourceLabel', () => {
  it('labels known OTA sources', () => {
    expect(otaSourceLabel('mmt')).toBe('MMT')
    expect(otaSourceLabel('agoda')).toBe('Agoda')
  })
})

describe('getGroupMembers', () => {
  const mk = (id: string, room: string, group?: string, status = 'confirmed') =>
    ({
      booking_id: id, room, guest_name: 'G', guest_mobile: '9',
      check_in_date: '2026-11-05', check_out_date: '2026-11-06',
      status, booking_source: 'normal', total_amount: 0, paid_amount: 0, balance: 0,
      group_booking_id: group,
    }) as import('../types/booking').Booking
  it('returns the single booking when it has no group', () => {
    const solo = mk('s', '101')
    expect(getGroupMembers([solo], solo)).toEqual([solo])
  })
  it('returns all non-cancelled members sorted by room', () => {
    const all = [mk('a', '305', 'G'), mk('b', '201', 'G'), mk('c', '101', 'G', 'cancelled')]
    const members = getGroupMembers(all, all[0])
    expect(members.map((m) => m.room)).toEqual(['201', '305'])
  })
})

describe('repeatGuestMobiles', () => {
  const mk = (mobile: string) =>
    ({
      booking_id: Math.random().toString(36).slice(2), room: '1', guest_name: 'G', guest_mobile: mobile,
      check_in_date: '2026-11-05', check_out_date: '2026-11-06', status: 'confirmed',
      booking_source: 'normal', total_amount: 0, paid_amount: 0, balance: 0,
    }) as import('../types/booking').Booking
  it('returns mobiles that appear more than once', () => {
    const set = repeatGuestMobiles([mk('999'), mk('999'), mk('888')])
    expect(set.has('999')).toBe(true)
    expect(set.has('888')).toBe(false)
  })
})

describe('paymentLabel', () => {
  it('reflects paid / partial / unpaid', () => {
    expect(paymentLabel({ paid_amount: 1000, total_amount: 1000 })).toBe('paid')
    expect(paymentLabel({ paid_amount: 400, total_amount: 1000 })).toBe('partial')
    expect(paymentLabel({ paid_amount: 0, total_amount: 1000 })).toBe('unpaid')
  })
})

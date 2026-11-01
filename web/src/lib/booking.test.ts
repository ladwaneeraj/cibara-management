import { isOtaPrepaid, otaSourceLabel, paymentLabel } from './booking'

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

describe('paymentLabel', () => {
  it('reflects paid / partial / unpaid', () => {
    expect(paymentLabel({ paid_amount: 1000, total_amount: 1000 })).toBe('paid')
    expect(paymentLabel({ paid_amount: 400, total_amount: 1000 })).toBe('partial')
    expect(paymentLabel({ paid_amount: 0, total_amount: 1000 })).toBe('unpaid')
  })
})

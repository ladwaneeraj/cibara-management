import { describe, expect, it } from 'vitest'
import { isMmtPrepaid, recomputeStats, renewalStatus } from '@/lib/realtime'
import type { Room } from '@/lib/types'
import { arrivalTone, cardTone, checklistFor, matchesFilter, photoKindsFor, photosRequired, renewalLabel } from './roomState'

const base = (over: Partial<Room>): Room => ({
  id: '201', status: 'vacant', category: 'premium', guest: null, checkin_time: null, balance: 0,
  _renewal: { day: 0, due: false, next_renewal: null, minutes_left: null }, _mmt_prepaid: false, ...over,
})
const occ = (over: Partial<Room> = {}) => base({
  status: 'occupied', guest: { name: 'Ravi', mobile: '9', price: 1200, guests: 2, payment: 'cash' },
  checkin_time: '2026-10-06 10:00', ...over,
})

describe('room state', () => {
  it('filters like the legacy grid', () => {
    expect(matchesFilter(occ({ balance: 300 }), 'balances', '')).toBe(true)
    expect(matchesFilter(occ({ balance: 300, _mmt_prepaid: true }), 'balances', '')).toBe(false)
    expect(matchesFilter(occ({ service_cleaning: { room: true } }), 'cleaning', '')).toBe(true)
    expect(matchesFilter(base({}), 'occupied', '')).toBe(false)
    expect(matchesFilter(occ(), 'all', 'rav')).toBe(true)
    expect(matchesFilter(occ(), 'all', '20')).toBe(true)
    expect(matchesFilter(occ(), 'all', 'zzz')).toBe(false)
  })
  it('derives card tone from status and cleaning stage', () => {
    expect(cardTone(base({ status: 'cleaning', cleaning_status: 'ready_to_inspect' }))).toBe('inspect')
    expect(cardTone(base({ status: 'cleaning', cleaning_status: 'in_progress' }))).toBe('cleaning')
    expect(cardTone(occ())).toBe('occupied')
  })
  it('colours arrival dots by hours until arrival', () => {
    expect(arrivalTone({ hours_until: -1 } as never)).toBe('red')
    expect(arrivalTone({ hours_until: 5 } as never)).toBe('amber')
    expect(arrivalTone({ hours_until: 12 } as never)).toBe('blue')
    expect(arrivalTone(undefined)).toBeNull()
  })
  it('shows renewal countdown only within two hours', () => {
    expect(renewalLabel(occ({ _renewal: { day: 1, due: true, next_renewal: null, minutes_left: -5 } }))?.text).toBe('Renewal due')
    expect(renewalLabel(occ({ _renewal: { day: 1, due: false, next_renewal: null, minutes_left: 95 } }))?.text).toBe('1h 35m left')
    expect(renewalLabel(occ({ _renewal: { day: 1, due: false, next_renewal: null, minutes_left: 300 } }))).toBeNull()
  })
  it('knows checklist and photo rules per room', () => {
    expect(checklistFor('203').map((c) => c.key)).toEqual(['washroom', 'coffee', 'towels'])
    expect(checklistFor('210').map((c) => c.key)).toEqual(['washroom', 'dustbin', 'towels'])
    expect(checklistFor('5').map((c) => c.key)).toEqual(['room_ready'])
    expect(photoKindsFor('203')).toEqual(['washroom', 'coffee', 'bed'])
    expect(photoKindsFor('5')).toEqual([])
    expect(photosRequired('210', 'manager', {}, 'ready')).toBe(true)
    expect(photosRequired('210', 'manager', { inspection_photos: false }, 'ready')).toBe(false)
    expect(photosRequired('210', 'admin', {}, 'ready')).toBe(false)
    expect(photosRequired('210', 'housekeeping', {}, 'cleaned')).toBe(false)
    expect(photosRequired('210', 'housekeeping', { cleaning_photos: true }, 'cleaned')).toBe(true)
  })
})

describe('live recomputation (mirrors backend dashboard.py)', () => {
  it('renewal is due 24h × day after check-in, in IST', () => {
    const r = { status: 'occupied' as const, guest: occ().guest, checkin_time: '2026-10-05 13:00', renewal_count: 0 }
    expect(renewalStatus(r, new Date('2026-10-06T07:31:00Z')).due).toBe(true) // 13:01 IST
    expect(renewalStatus(r, new Date('2026-10-06T07:29:00Z')).due).toBe(false)
    expect(renewalStatus({ ...r, renewal_count: 1 }, new Date('2026-10-06T08:30:00Z')).minutes_left).toBe(23 * 60)
  })
  it('counts stats like updateStats', () => {
    const rooms = [base({}), base({ id: '2', status: 'cleaning' }),
      occ({ id: '3', balance: 0, guest: { ...occ().guest!, payment: 'ota' }, service_cleaning: { room: true } }),
      occ({ id: '4', balance: 300, _renewal: { day: 1, due: true, next_renewal: null, minutes_left: -1 } })]
    expect(recomputeStats(rooms)).toEqual({ vacant: 1, occupied: 2, cleaning: 2, balances_total: 300, balances_count: 1, renewals_due: 1, total: 4 })
    expect(isMmtPrepaid(rooms[2])).toBe(true)
  })
})

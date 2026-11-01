import { installBridge, uninstallBridge } from './bridge'

describe('bridge globals for room-calendar.js', () => {
  afterEach(() => uninstallBridge())

  it('wires window.fetchBookings to controller.refresh', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    installBridge({ refresh, openDrawer: vi.fn(), openNewBooking: vi.fn() })
    await window.fetchBookings!()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('wires window.showBookingDetails to controller.openDrawer', () => {
    const openDrawer = vi.fn()
    installBridge({ refresh: vi.fn(), openDrawer, openNewBooking: vi.fn() })
    window.showBookingDetails!('b1')
    expect(openDrawer).toHaveBeenCalledWith('b1')
  })

  it('wires window.showNewBookingModalForDate to controller.openNewBooking with the date', () => {
    const openNewBooking = vi.fn()
    installBridge({ refresh: vi.fn(), openDrawer: vi.fn(), openNewBooking })
    window.showNewBookingModalForDate!('2026-11-05')
    expect(openNewBooking).toHaveBeenCalledWith({ date: '2026-11-05' })
  })

  it('uninstall removes the globals', () => {
    installBridge({ refresh: vi.fn(), openDrawer: vi.fn(), openNewBooking: vi.fn() })
    uninstallBridge()
    expect(window.fetchBookings).toBeUndefined()
    expect(window.showBookingDetails).toBeUndefined()
    expect(window.showNewBookingModalForDate).toBeUndefined()
  })
})

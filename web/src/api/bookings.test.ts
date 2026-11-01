import * as api from './bookings'

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('bookings api', () => {
  afterEach(() => {
    delete (window as unknown as { apiFetch?: unknown }).apiFetch
  })

  it('getBookings returns the bookings array', async () => {
    window.apiFetch = vi
      .fn()
      .mockResolvedValue(ok({ success: true, bookings: [{ booking_id: 'b1', room: '101' }] }))
    const list = await api.getBookings()
    expect(list).toHaveLength(1)
    expect(list[0].booking_id).toBe('b1')
  })

  it('checkAvailability returns available_rooms', async () => {
    window.apiFetch = vi.fn().mockResolvedValue(ok({ success: true, available_rooms: ['101', '102'] }))
    const rooms = await api.checkAvailability({
      check_in_date: '2026-11-05',
      check_out_date: '2026-11-06',
    })
    expect(rooms).toEqual(['101', '102'])
  })

  it('createBooking posts to /create_booking and returns the new id', async () => {
    const spy = vi.fn().mockResolvedValue(ok({ success: true, booking_id: 'new1' }))
    window.apiFetch = spy
    const id = await api.createBooking({
      room: '101',
      guest_name: 'A',
      guest_mobile: '9',
      check_in_date: '2026-11-05',
      check_in_time: '14:00',
      check_out_date: '2026-11-06',
      total_amount: 1000,
    })
    expect(id).toBe('new1')
    expect(spy.mock.calls[0][0]).toBe('/create_booking')
  })
})

import type { Booking } from '../types/booking'

export interface GroupCheckinResult {
  room: string
  ok: boolean
  error?: string
}

// Check every confirmed member of a group in, one at a time (each conversion
// is its own request → its own X-Op-Id). Non-confirmed members are skipped. A
// per-room failure is recorded and does not abort the rest.
export async function groupCheckin(
  members: Booking[],
  convert: (bookingId: string) => Promise<void>,
): Promise<GroupCheckinResult[]> {
  const results: GroupCheckinResult[] = []
  for (const m of members) {
    if (m.status !== 'confirmed') continue
    try {
      await convert(m.booking_id)
      results.push({ room: m.room, ok: true })
    } catch (e) {
      results.push({ room: m.room, ok: false, error: e instanceof Error ? e.message : 'Check-in failed' })
    }
  }
  return results
}

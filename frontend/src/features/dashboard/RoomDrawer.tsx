import { CalendarDays } from 'lucide-react'
import { Badge, Drawer, Notice } from '@/components/ui'
import { useCan } from '@/lib/auth'
import type { Room, Upcoming } from '@/lib/types'
import { CheckinForm } from './CheckinForm'
import { CleaningPanel } from './CleaningPanel'
import { OccupiedPanel } from './OccupiedPanel'
import { cardTone } from './roomState'

const label = { vacant: 'Available', occupied: 'Occupied', cleaning: 'Cleaning', inspect: 'Ready to inspect' }
const tone = { vacant: 'green', occupied: 'brand', cleaning: 'amber', inspect: 'blue' } as const

export function RoomDrawer({ room, upcoming, uiConfig, onClose }: {
  room: Room | null; upcoming?: Upcoming; uiConfig: Record<string, boolean>; onClose: () => void
}) {
  const canCheckin = useCan('room.checkin')
  if (!room) return null
  const t = cardTone(room)
  return (
    <Drawer
      open
      onClose={onClose}
      title={<span className="flex items-center gap-2">Room {room.id} <Badge tone={tone[t]}>{label[t]}</Badge></span>}
      subtitle={<span className="capitalize">{room.category.replace(/-/g, ' ')}</span>}
    >
      {upcoming && (
        <div className="mb-4">
          <Notice tone={upcoming.hours_until <= 3 ? 'red' : 'blue'}>
            <span className="flex items-center gap-2"><CalendarDays className="size-4" />
              {upcoming.hours_until <= 0 ? 'Overdue arrival' : 'Booked'}: {upcoming.guest_name} · {upcoming.check_in_date} {upcoming.check_in_time || ''}
            </span>
          </Notice>
        </div>
      )}
      {room.status === 'vacant' && (canCheckin
        ? <CheckinForm key={room.id} room={room} onDone={onClose} />
        : <p className="text-sm text-slate-500">This room is ready for the next guest.</p>)}
      {room.status === 'occupied' && room.guest && <OccupiedPanel key={room.active_bill_id || room.id} room={room} onDone={onClose} />}
      {room.status === 'cleaning' && <CleaningPanel key={room.id} room={room} uiConfig={uiConfig} onDone={onClose} />}
    </Drawer>
  )
}

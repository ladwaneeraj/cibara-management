import { Bath, Snowflake, Sparkles, Users } from 'lucide-react'
import { memo, type ReactNode } from 'react'
import { cls, duration, money } from '@/lib/format'
import type { Room, Upcoming } from '@/lib/types'
import { arrivalTone, cardTone, elapsedSince, renewalLabel } from './roomState'

const toneStyles = {
  vacant: { bar: 'bg-emerald-500', bg: '', pill: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20' },
  occupied: { bar: 'bg-brand-600 dark:bg-brand-400', bg: 'bg-brand-50/40 dark:bg-brand-500/[0.06]', pill: '' },
  cleaning: { bar: 'bg-amber-500', bg: 'bg-amber-50/50 dark:bg-amber-500/[0.06]', pill: 'bg-amber-50 text-amber-800 ring-amber-600/25 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20' },
  inspect: { bar: 'bg-sky-500', bg: 'bg-sky-50/50 dark:bg-sky-500/[0.06]', pill: 'bg-sky-50 text-sky-700 ring-sky-600/25 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/20' },
}

function Pill({ className, children }: { className: string; children: ReactNode }) {
  return <span className={cls('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset', className)}>{children}</span>
}

export const RoomCard = memo(function RoomCard({ room, upcoming, onOpen, now }: {
  room: Room; upcoming?: Upcoming; onOpen: (id: string) => void; now: Date
}) {
  const tone = cardTone(room)
  const st = toneStyles[tone]
  const g = room.guest
  const renewal = renewalLabel(room)
  const arrival = arrivalTone(upcoming)
  const sc = room.service_cleaning || {}
  const n = Number(room.id)
  const elapsed = room.status === 'cleaning' ? elapsedSince(room.cleaning_start_time, now) : null

  return (
    <button
      type="button"
      onClick={() => onOpen(room.id)}
      aria-label={`Room ${room.id}, ${tone === 'inspect' ? 'ready to inspect' : room.status}${g ? `, ${g.name}` : ''}`}
      className={cls('card group relative flex min-h-[112px] flex-col overflow-hidden py-2.5 pl-3.5 pr-2.5 text-left transition hover:border-slate-300 hover:shadow-md focus-visible:border-brand-500 dark:hover:border-white/20', st.bg)}
    >
      <span className={cls('absolute inset-y-0 left-0 w-[3px]', st.bar, tone === 'cleaning' && 'animate-pulse')} aria-hidden />
      <div className="flex items-start justify-between gap-1">
        <span className="num text-lg font-bold leading-6 tracking-tight text-slate-900 dark:text-white">{room.id}</span>
        <div className="flex items-center gap-1">
          {arrival && (
            <span title={upcoming!.hours_until <= 0 ? `Overdue — ${upcoming!.guest_name}` : `${upcoming!.guest_name} arriving ${upcoming!.check_in_time || ''}`}
              className={cls('size-2.5 rounded-full', arrival === 'red' ? 'bg-rose-500 pulse-ring' : arrival === 'amber' ? 'bg-amber-400' : 'bg-sky-500')} />
          )}
          {g && n >= 200 && n <= 206 && g.isAC && <Snowflake className="size-3.5 text-cyan-500" aria-label="AC" />}
          {g && <span className="flex items-center gap-0.5 text-[11px] text-slate-500"><Users className="size-3" />{g.guests || 1}</span>}
        </div>
      </div>

      {room.status === 'occupied' && g ? (
        <>
          <div className="mt-1 flex min-w-0 items-center gap-1">
            {g.payment === 'ota' && <span className="rounded bg-violet-100 px-1 text-[10px] font-bold text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">MMT</span>}
            <span className="truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100">{g.name}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {room._renewal.day > 1 && <span className="rounded bg-slate-100 px-1.5 text-[10px] font-semibold text-slate-600 dark:bg-white/10 dark:text-slate-300">D{room._renewal.day}</span>}
            {renewal && (
              <span className={cls('rounded px-1.5 text-[10px] font-semibold', renewal.urgent ? 'bg-rose-500 text-white' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300')}>
                {renewal.text}
              </span>
            )}
            {sc.room && <Sparkles className="size-3.5 text-amber-500" aria-label="Room cleaning requested" />}
            {sc.bathroom && <Bath className="size-3.5 text-amber-500" aria-label="Bathroom cleaning requested" />}
          </div>
          <div className="mt-auto flex items-end justify-between gap-1 pt-2 text-[11px] text-slate-500">
            <span className="num">{money(g.price)} · {room.checkin_time?.slice(11, 16)}</span>
            {room.balance > 0 && !room._mmt_prepaid && <span className="num rounded bg-rose-50 px-1.5 py-0.5 font-semibold text-rose-700 ring-1 ring-inset ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-300">{money(room.balance)}</span>}
            {room.balance < 0 && <span className="num rounded bg-emerald-50 px-1.5 py-0.5 font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300">{money(-room.balance)}</span>}
          </div>
        </>
      ) : room.status === 'cleaning' ? (
        <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-2">
          <Pill className={st.pill}>{tone === 'inspect' ? 'Ready to inspect' : 'Cleaning'}</Pill>
          {elapsed != null && <span className="num text-[11px] text-slate-500">{duration(elapsed)} ago</span>}
        </div>
      ) : (
        <div className="mt-auto pt-2">
          {upcoming && <div className="mb-1 truncate text-[11px] text-slate-500">Booked · {upcoming.guest_name}</div>}
          <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Vacant</span>
        </div>
      )}
    </button>
  )
})

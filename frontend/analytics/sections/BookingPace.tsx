import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { Card } from '@/components/ui'
import { cls, count, money } from '@/lib/format'
import { Columns } from '../charts'
import { pct, signed } from '../format'
import type { BookingPace as BookingPaceData, PaceDelta, PaceHorizon, PaceHorizonKey } from '../types'

const KEYS: PaceHorizonKey[] = ['7', '14', '30']

interface Change { occ: number | null; rev: number | null }

/** Backend sends an object (or, tolerated, a bare number of occupancy points);
 *  null / empty means no snapshot to compare against yet. */
function changeOf(d: PaceHorizon['delta']): Change | null {
  if (d == null) return null
  if (typeof d === 'number') return Number.isFinite(d) ? { occ: d, rev: null } : null
  const x = d as PaceDelta
  const occ = x.occupancy_pct == null ? null : Number(x.occupancy_pct)
  const rev = x.on_books_revenue == null ? null : Number(x.on_books_revenue)
  return occ === null && rev === null ? null : { occ, rev }
}

const signedMoney = (v: number) => `${v < 0 ? '-' : '+'}${money(Math.abs(v))}`

function Delta({ change }: { change: Change }) {
  const lead = change.occ ?? change.rev ?? 0
  const up = lead >= 0
  const Icon = up ? ArrowUpRight : ArrowDownRight
  const parts = [change.occ !== null && `${signed(change.occ)} pts`, change.rev !== null && signedMoney(change.rev)].filter(Boolean)
  return (
    <p className={cls('mt-2 flex items-center gap-1 text-xs font-medium', up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span>{parts.join(' · ')} vs last week</span>
    </p>
  )
}

/** Forward occupancy and revenue already on the books for the next 7 / 14 / 30 nights. */
export function BookingPace({ data }: { data: BookingPaceData }) {
  const items = KEYS.flatMap((k) => (data.horizons[k] ? [{ k, h: data.horizons[k]! }] : []))
  const anyMissingDelta = items.some(({ h }) => changeOf(h.delta) === null)
  return (
    <Card title="Booking pace">
      <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,18rem)]">
        <div className="grid gap-3 sm:grid-cols-3">
          {items.map(({ k, h }) => {
            const change = changeOf(h.delta)
            return (
              <div key={k} data-horizon={k} className="rounded-xl border border-slate-200 p-3.5 dark:border-white/10">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Next {k} nights</p>
                <p className="num mt-1 text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">{pct(h.occupancy_pct)}</p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {count(h.occupied_room_nights)} of {count(h.available_room_nights)} room-nights
                </p>
                <p className="num mt-2 text-sm font-medium text-slate-800 dark:text-slate-100">{money(h.on_books_revenue)} <span className="font-normal text-slate-500">on the books</span></p>
                {change && <Delta change={change} />}
              </div>
            )
          })}
        </div>
        {items.length > 0 && (
          <div aria-hidden>
            <Columns
              height={170}
              name="Forward occupancy"
              dataKey="occupancy"
              colorEach
              format={(v) => `${Math.round(v)}%`}
              data={items.map(({ k, h }) => ({ name: `${k}n`, occupancy: h.occupancy_pct }))}
            />
          </div>
        )}
      </div>
      {anyMissingDelta && (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          The comparison with last week builds up as nightly snapshots accumulate.
        </p>
      )}
    </Card>
  )
}

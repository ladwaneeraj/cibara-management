import { Banknote, BedDouble, CalendarClock, IndianRupee, TrendingUp, Wallet } from 'lucide-react'
import { StatCard } from '@/components/ui'
import { money, shortDate } from '@/lib/format'
import { pct } from '../format'
import type { AnalyticsOverview } from '../types'

/** KPI strip: every figure comes straight from the server's register-basis payload. */
export function Overview({ data }: { data: AnalyticsOverview }) {
  const { occupancy: o, collections: c, on_books_next7: nb } = data.overview
  const w = data.window
  return (
    <section aria-labelledby="sec-overview" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="sec-overview" className="text-[13px] font-semibold tracking-tight text-slate-800 dark:text-slate-100">Overview</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {shortDate(w.from)} – {shortDate(w.to)} · {w.days} {w.days === 1 ? 'day' : 'days'}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Occupancy" tone="brand" icon={<BedDouble className="size-4" />} value={pct(o.occupancy_pct)}
          hint={`${o.occupied_room_nights} of ${o.available_room_nights} room-nights`} />
        <StatCard label="ADR" tone="green" icon={<IndianRupee className="size-4" />} value={money(o.adr)} hint="per occupied room-night" />
        <StatCard label="RevPAR" tone="violet" icon={<TrendingUp className="size-4" />} value={money(o.revpar)} hint="per available room-night" />
        <StatCard label="Net revenue" tone="accent" icon={<Wallet className="size-4" />} value={money(c.net_revenue)}
          hint={`Room revenue ${money(o.room_revenue)}`} />
        <StatCard label="Collections" tone="cyan" icon={<Banknote className="size-4" />} value={money(c.net)}
          hint={`Cash ${money(c.cash)} · online ${money(c.online)} · refunds ${money(c.refunds)}`} />
        <StatCard label="On the books, next 7 nights" tone="blue" icon={<CalendarClock className="size-4" />} value={pct(nb.occupancy_pct)}
          hint={`${money(nb.on_books_revenue)} booked`} />
      </div>
    </section>
  )
}

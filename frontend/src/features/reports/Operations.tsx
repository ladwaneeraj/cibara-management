import { useQuery } from '@tanstack/react-query'
import { Card, ErrorState, Notice, Skeleton, StatCard } from '@/components/ui'
import { get } from '@/lib/api'
import { duration, money, shortDate } from '@/lib/format'
import { OpsTrend } from './charts'
import type { Range } from './FinancePage'
import { daysBetween } from './Overview'

interface Day {
  date: string; cleanings: number; checkouts: number; checkins: number
  turnaround: { avg_min: number | null }
  staff: { name: string; cleaned: number; inspected: number; avg_clean_min: number | null }[]
  occupancy: { occupancy_pct: number; adr: number; revpar: number } | null
}
interface Insights {
  days: Day[]
  totals: { cleanings: number; checkouts: number; checkins: number; avg_turnaround_min: number | null; median_turnaround_min: number | null;
    revenue_net: number; avg_occupancy_pct: number | null; busiest_weekday: string | null; slow_cleanings: number }
  live: { pending: { room: string; stage: string; elapsed_min: number; cleaned_by?: string }[] }
  slow_threshold_min: number
}

export function Operations({ range }: { range: Range }) {
  const tooLong = daysBetween(range) > 92
  const q = useQuery({
    queryKey: ['ops', range],
    enabled: !tooLong,
    queryFn: () => get<Insights>('/api/v2/reports/insights', range),
  })
  if (tooLong) return <Notice>Operations analytics cover up to 92 days. Pick a shorter period.</Notice>
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const d = q.data
  if (!d) return <Skeleton className="h-96" />
  const staff = new Map<string, { cleaned: number; inspected: number }>()
  for (const day of d.days) for (const s of day.staff) {
    const cur = staff.get(s.name) || { cleaned: 0, inspected: 0 }
    staff.set(s.name, { cleaned: cur.cleaned + s.cleaned, inspected: cur.inspected + s.inspected })
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Rooms cleaned" value={d.totals.cleanings} hint={`${d.totals.slow_cleanings} over ${d.slow_threshold_min} min`} tone="cyan" />
        <StatCard label="Avg turnaround" value={duration(d.totals.avg_turnaround_min)} hint={`Median ${duration(d.totals.median_turnaround_min)}`} tone="amber" />
        <StatCard label="Check-ins / outs" value={`${d.totals.checkins} / ${d.totals.checkouts}`} tone="brand" />
        <StatCard label="Avg occupancy" value={d.totals.avg_occupancy_pct != null ? `${d.totals.avg_occupancy_pct}%` : '—'} hint={d.totals.busiest_weekday ? `Busiest: ${d.totals.busiest_weekday}` : undefined} tone="green" />
        <StatCard label="Net collected" value={money(d.totals.revenue_net)} tone="violet" />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Cleaning throughput" className="xl:col-span-2">
          <OpsTrend data={d.days.map((x) => ({ day: shortDate(x.date), cleanings: x.cleanings, turnaround: x.turnaround.avg_min }))} />
        </Card>
        <Card title="Rooms waiting right now">
          {d.live.pending.length === 0 ? <p className="text-sm text-slate-500">Nothing pending.</p> : (
            <ul className="space-y-2">{d.live.pending.map((p) => (
              <li key={p.room} className="flex items-center justify-between text-sm"><span>Room {p.room} · <span className="text-slate-500">{p.stage.replace(/_/g, ' ')}</span></span><span className="num">{duration(p.elapsed_min)}</span></li>
            ))}</ul>
          )}
        </Card>
      </div>
      <Card title="Housekeeping by person">
        {staff.size === 0 ? <p className="text-sm text-slate-500">No recorded cleanings.</p> : (
          <table className="w-full text-sm"><thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-2">Name</th><th className="text-right">Cleaned</th><th className="text-right">Inspected</th></tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5">{[...staff.entries()].sort((a, b) => b[1].cleaned - a[1].cleaned).map(([n, s]) => (
              <tr key={n}><td className="py-2">{n}</td><td className="num text-right">{s.cleaned}</td><td className="num text-right">{s.inspected}</td></tr>
            ))}</tbody></table>
        )}
      </Card>
    </div>
  )
}

import { useState } from 'react'
import { Card, EmptyState, Segmented } from '@/components/ui'
import { compactInr, Columns, Lines } from '../charts'
import { money } from '@/lib/format'
import { monthLabel, pct } from '../format'
import type { Seasonality as SeasonalityData, SeasonPoint } from '../types'

type Metric = 'occupancy_pct' | 'adr' | 'revpar'

const METRICS: { value: Metric; label: string }[] = [
  { value: 'occupancy_pct', label: 'Occupancy' },
  { value: 'adr', label: 'ADR' },
  { value: 'revpar', label: 'RevPAR' },
]

/** A month with nothing at all recorded is "no history", not a soft month. */
const hasData = (p: SeasonPoint) => p.occupancy_pct > 0 || p.adr > 0 || p.revpar > 0

function extremes<T extends SeasonPoint>(rows: T[], metric: Metric, label: (r: T) => string, fmt: (v: number) => string) {
  const ranked = rows.filter(hasData)
  if (ranked.length < 2) return null
  const hi = ranked.reduce((a, b) => (b[metric] > a[metric] ? b : a))
  const lo = ranked.reduce((a, b) => (b[metric] < a[metric] ? b : a))
  return { hi: `${label(hi)} (${fmt(hi[metric])})`, lo: `${label(lo)} (${fmt(lo[metric])})` }
}

/** Occupancy / ADR / RevPAR by weekday (the window) and by month (trailing 12). */
export function Seasonality({ data }: { data: SeasonalityData }) {
  const [metric, setMetric] = useState<Metric>('occupancy_pct')
  const isPct = metric === 'occupancy_pct'
  const fmt = isPct ? pct : money
  const axis = isPct ? (v: number) => `${Math.round(v)}%` : compactInr
  const label = METRICS.find((m) => m.value === metric)!.label

  const empty = data.weekday.length === 0 && data.months.length === 0
  const wd = extremes(data.weekday, metric, (r) => r.weekday, fmt)
  const mo = extremes(data.months, metric, (r) => monthLabel(r.month), fmt)

  return (
    <Card title="Seasonality" action={!empty && <Segmented size="sm" value={metric} onChange={setMetric} options={METRICS} />}>
      {empty ? (
        <EmptyState title="Not enough history yet" hint="Weekday and monthly patterns appear once stays have been recorded." />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">{label} by weekday (selected dates)</h3>
            <Columns
              data={data.weekday.map((w) => ({ name: w.weekday.slice(0, 3), value: w[metric] }))}
              dataKey="value" name={label} format={axis} colorEach={false}
            />
            {wd && (
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                <span className="text-slate-500">Strongest weekday:</span> <b className="font-semibold">{wd.hi}</b>
                <span className="mx-1.5 text-slate-300">·</span>
                <span className="text-slate-500">Softest weekday:</span> <b className="font-semibold">{wd.lo}</b>
              </p>
            )}
          </div>
          <div data-testid="month-chart">
            <h3 className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">{label} by month (last 12 months)</h3>
            <Lines
              data={data.months.map((m) => ({ name: monthLabel(m.month), value: m[metric] }))}
              series={[{ key: 'value', name: label }]} yFormat={axis} tipFormat={(v) => fmt(v)}
            />
            {mo && (
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                <span className="text-slate-500">Strongest month:</span> <b className="font-semibold">{mo.hi}</b>
                <span className="mx-1.5 text-slate-300">·</span>
                <span className="text-slate-500">Softest month:</span> <b className="font-semibold">{mo.lo}</b>
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

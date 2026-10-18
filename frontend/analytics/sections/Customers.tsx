/**
 * ── Customers ───────────────────────────────────────────────────────────────
 * A clearly delimited section that reuses the existing CRM endpoints as-is:
 *   GET /customer_insights   (one cached, projected scan on the server)
 *   GET /customer_segment    (drill-through, served from that same scan)
 * Both require `customer.manage`. If the viewer lacks it the server answers 403
 * and this whole section renders nothing; the rest of the page is unaffected.
 */
import { useState } from 'react'
import { Card, ErrorState, Skeleton, Spinner, StatCard, Tabs } from '@/components/ui'
import { cls, count, money, shortDate } from '@/lib/format'
import { isForbidden, useCustomerInsights, useCustomerSegment } from '../api'
import { Lines } from '../charts'
import { monthLabel, pct } from '../format'
import type { CustomerInsights, CustomerRow, SegmentDimension } from '../types'

const GROUPS: { dimension: SegmentDimension; title: string }[] = [
  { dimension: 'loyalty', title: 'Loyalty (number of stays)' },
  { dimension: 'value', title: 'Value (lifetime spend)' },
  { dimension: 'recency', title: 'Recency (since last stay)' },
]

const SHOWN_IN_DRILL = 25

interface Picked { dimension: SegmentDimension; index: number; label: string }

function SegmentBars({ segments, picked, onPick }: {
  segments: CustomerInsights['segments']; picked: Picked | null; onPick: (p: Picked | null) => void
}) {
  return (
    <div className="space-y-4">
      {GROUPS.map(({ dimension, title }) => {
        const bands = segments[dimension] ?? []
        const max = Math.max(1, ...bands.map((b) => b.count))
        return (
          <div key={dimension}>
            <h3 className="mb-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">{title}</h3>
            <ul className="space-y-1">
              {bands.map((b, index) => {
                const on = picked?.dimension === dimension && picked.index === index
                return (
                  <li key={b.label}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => onPick(on ? null : { dimension, index, label: b.label })}
                      className={cls(
                        'group relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-md border px-2.5 py-1.5 text-left text-sm transition',
                        on ? 'border-brand-400 ring-1 ring-brand-400' : 'border-slate-200 hover:border-slate-300 dark:border-white/10 dark:hover:border-white/20',
                      )}
                    >
                      <span aria-hidden className="absolute inset-y-0 left-0 bg-brand-100/70 dark:bg-brand-500/20" style={{ width: `${(b.count / max) * 100}%` }} />
                      <span className="relative font-medium text-slate-800 dark:text-slate-100">{b.label}</span>
                      <span className="num relative text-slate-600 dark:text-slate-300">{count(b.count)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function GuestTable({ rows, total }: { rows: CustomerRow[]; total?: number }) {
  if (rows.length === 0) return <p className="py-3 text-sm text-slate-500">No guests to show.</p>
  const shown = rows.slice(0, SHOWN_IN_DRILL)
  return (
    <div className="-mx-4 overflow-x-auto sm:-mx-5">
      <table className="table-erp min-w-[520px]">
        <thead>
          <tr>
            <th scope="col">Guest</th>
            <th scope="col" className="text-right">Stays</th>
            <th scope="col" className="text-right">Spent</th>
            <th scope="col" className="text-right">Last stay</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.mobile || r.name}>
              <td>
                <span className="font-medium text-slate-800 dark:text-slate-100">{r.name || '—'}</span>
                {r.mobile && <span className="ml-2 text-xs text-slate-500">{r.mobile}</span>}
              </td>
              <td className="num text-right">{count(r.total_stays)}</td>
              <td className="num text-right">{money(r.total_spent)}</td>
              <td className="num text-right text-slate-500">{shortDate(r.last_stay_date)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(total ?? rows.length) > shown.length && (
        <p className="px-4 pt-2 text-xs text-slate-500 sm:px-5">Showing the top {shown.length} of {count(total ?? rows.length)}.</p>
      )}
    </div>
  )
}

function Drill({ picked }: { picked: Picked }) {
  const seg = useCustomerSegment(picked.dimension, picked.index)
  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-white/10">
      <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
        {picked.label}
        {seg.data && <span className="ml-2 font-normal text-slate-500">{count(seg.data.count)} {seg.data.count === 1 ? 'guest' : 'guests'}</span>}
      </h3>
      {seg.isPending ? <div className="grid h-16 place-items-center"><Spinner /></div>
        : seg.isError ? <ErrorState error={seg.error} onRetry={() => void seg.refetch()} />
        : <GuestTable rows={seg.data.customers} total={seg.data.count} />}
    </div>
  )
}

function Body({ d }: { d: CustomerInsights }) {
  const k = d.kpis
  const [picked, setPicked] = useState<Picked | null>(null)
  const [top, setTop] = useState<'spend' | 'stays'>('spend')
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Guest base" tone="brand" value={count(k.total_customers)} hint={`${count(k.active_90d)} active in 90 days · ${count(k.new_30d)} new in 30`} />
        <StatCard label="Repeat rate" tone="green" value={pct(k.repeat_rate_pct)} hint={`${count(k.repeat_customers)} returning guests`} />
        <StatCard label="Lifetime revenue" tone="accent" value={money(k.total_revenue)} />
        <StatCard label="Avg spend per guest" tone="violet" value={money(k.avg_spend)} hint={`${k.avg_stays} ${k.avg_stays === 1 ? 'stay' : 'stays'} on average`} />
        <StatCard label="Outstanding dues" tone={k.dues_total > 0 ? 'red' : 'slate'} value={money(k.dues_total)} hint={`${count(k.dues_count)} ${k.dues_count === 1 ? 'guest' : 'guests'}`} />
        <StatCard label="Top 10% of guests" tone="cyan" value={pct(k.top10_revenue_share_pct)} hint={`of revenue · top 20%: ${pct(k.top20_revenue_share_pct)}`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">Click a band to see who is in it.</p>
          <SegmentBars segments={d.segments} picked={picked} onPick={setPicked} />
        </div>
        <div data-testid="acquisition-chart">
          <h3 className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">New guests per month (last 12 months)</h3>
          <Lines
            data={d.acquisition_trend.map((m) => ({ name: monthLabel(m.month), value: m.count }))}
            series={[{ key: 'value', name: 'New guests' }]}
            yFormat={(v) => String(Math.round(v))}
          />
        </div>
      </div>

      {picked && <Drill picked={picked} />}

      <div>
        <Tabs value={top} onChange={setTop} tabs={[{ value: 'spend', label: 'Top spenders' }, { value: 'stays', label: 'Most stays' }]} />
        <div className="pt-3">
          <GuestTable rows={top === 'spend' ? d.top_by_spend : d.top_by_stays} />
        </div>
      </div>
    </div>
  )
}

/** Hidden (renders nothing) when the viewer lacks customer.manage. */
export function Customers() {
  const q = useCustomerInsights()
  if (q.isError && isForbidden(q.error)) return null
  return (
    <Card title="Customers">
      {q.isPending ? <Skeleton className="h-40" />
        : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : <Body d={q.data} />}
    </Card>
  )
}

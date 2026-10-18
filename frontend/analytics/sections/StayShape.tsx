import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, EmptyState } from '@/components/ui'
import { count } from '@/lib/format'
import { AXIS, GRID, PALETTE, TIP_STYLE } from '../charts'
import { pct } from '../format'
import type { Bucket, LosLeadtime } from '../types'

const WALK_IN = '#94a3b8'
const WALK_IN_BUCKET = 'walk-in'

function Histogram({ rows, testId, unit }: { rows: Bucket[]; testId: string; unit: string }) {
  return (
    <div data-testid={testId}>
      <ResponsiveContainer width="100%" height={210}>
        <BarChart data={rows} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="bucket" tick={AXIS} tickLine={false} axisLine={false} interval={0} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
          <Tooltip contentStyle={TIP_STYLE} formatter={(v: number) => [count(v), unit]} cursor={{ fill: 'rgba(148,163,184,.12)' }} />
          <Bar dataKey="count" name={unit} radius={[3, 3, 0, 0]} maxBarSize={44} isAnimationActive={false}>
            {rows.map((r) => <Cell key={r.bucket} fill={r.bucket === WALK_IN_BUCKET ? WALK_IN : PALETTE[0]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** How long guests stay, and how far ahead they book. */
export function StayShape({ data }: { data: LosLeadtime }) {
  const total = data.lead_time.reduce((s, b) => s + b.count, 0)
  const walkIns = data.lead_time.find((b) => b.bucket === WALK_IN_BUCKET)?.count ?? 0
  const empty = data.los.every((b) => b.count === 0) && total === 0
  return (
    <Card title="Length of stay & lead time">
      {empty ? (
        <EmptyState title="No stays in this window" hint="Stay-length and booking lead-time patterns appear once guests have stayed." />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Length of stay (nights)</h3>
            <Histogram rows={data.los} testId="los-chart" unit="Stays" />
          </div>
          <div>
            <h3 className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Lead time (days between booking and arrival)</h3>
            <Histogram rows={data.lead_time} testId="lead-chart" unit="Stays" />
            {total > 0 && walkIns > 0 && (
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                <span className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ background: WALK_IN }} aria-hidden />
                {count(walkIns)} of {count(total)} stays ({pct((walkIns / total) * 100)}) were walk-ins — no booking, so no lead time.
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

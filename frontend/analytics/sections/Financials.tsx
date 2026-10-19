/**
 * Financial performance — the old classic "Analytics" tab, rebuilt.
 *
 * Source: POST /reports (payment/expense basis), exactly what the legacy
 * screen used. Every figure and insight is derived here the same way the old
 * static/analytics.js did, so the numbers match the classic screen.
 */
import type { ReactNode } from 'react'
import { ArrowLeftRight, BadgeIndianRupee, CalendarDays, DoorOpen, Percent, PiggyBank, Receipt, Trophy, Undo2, Wallet } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, EmptyState, StatCard } from '@/components/ui'
import { money } from '@/lib/format'
import { ADDON_COLOR, AXIS, CASH_COLOR, GRID, NEUTRAL, ONLINE_COLOR, TIP_STYLE, compactInr, Donut } from '../charts'
import { Count, Money, Pct } from '../anim'
import { ChartCard } from '../Panel'
import type { FinancialsReport, PaymentLog } from '../types'

const day = (d?: string) => (d ?? '').slice(0, 10)
const ddmm = (iso: string) => { const [, m, d] = iso.split('-'); return d && m ? `${d}/${m}` : iso }

/** Sum `amount` of logs grouped by a key, returned sorted desc. */
function groupSum(logs: PaymentLog[], keyOf: (p: PaymentLog) => string): [string, number][] {
  const m = new Map<string, number>()
  for (const p of logs) {
    const k = keyOf(p)
    if (!k) continue
    m.set(k, (m.get(k) ?? 0) + Number(p.amount || 0))
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}

function Insight({ icon, tone, label, value }: { icon: ReactNode; tone: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-white/[0.07] dark:bg-ink-900">
      <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${tone}`}>{icon}</span>
      <div className="min-w-0">
        <div className="truncate text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
        <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{value}</div>
      </div>
    </div>
  )
}

export function Financials({ data, days }: { data?: FinancialsReport; days: number }) {
  if (!data) {
    return (
      <Card><EmptyState title="Financials unavailable" hint="No revenue or expense data for this period." /></Card>
    )
  }

  const cash = Number(data.cash_total || 0)
  const online = Number(data.online_total || 0)
  const gross = cash + online
  const expenses = Number(data.expense_total || 0)
  const netProfit = gross - expenses
  const margin = gross > 0 ? (netProfit / gross) * 100 : 0
  const refunds = Number(data.refund_total || 0)
  const refundRate = gross > 0 ? (refunds / gross) * 100 : 0
  const addon = Number(data.addon_total || 0)
  const checkins = Number(data.checkins || 0)
  const renewals = Number(data.renewals || 0)
  const stays = checkins + renewals
  const avgDaily = days > 0 ? gross / days : 0
  const avgPerStay = stays > 0 ? gross / stays : 0
  const cashPct = gross > 0 ? Math.round((cash / gross) * 100) : 0
  const expRatio = gross > 0 ? (expenses / gross) * 100 : 0

  // Key insights, derived from the raw logs like the classic screen.
  const revLogs = [...data.cash_logs, ...data.online_logs]
  const byDay = groupSum(revLogs, (p) => day(p.date))
  const bestDay = byDay[0]
  const byRoom = groupSum(revLogs, (p) => (p.room != null && p.room !== '' ? `Room ${p.room}` : ''))
  const topRoom = byRoom[0]

  // Daily revenue (cash vs online) — one row per day, chronological.
  const dayMap = new Map<string, { name: string; cash: number; online: number }>()
  for (const p of data.cash_logs) {
    const k = day(p.date); if (!k) continue
    const row = dayMap.get(k) ?? { name: ddmm(k), cash: 0, online: 0 }
    row.cash += Number(p.amount || 0); dayMap.set(k, row)
  }
  for (const p of data.online_logs) {
    const k = day(p.date); if (!k) continue
    const row = dayMap.get(k) ?? { name: ddmm(k), cash: 0, online: 0 }
    row.online += Number(p.amount || 0); dayMap.set(k, row)
  }
  const daily = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v)

  const topRooms = byRoom.slice(0, 6).map(([name, value]) => ({ name, value }))
  const split = [
    { name: 'Cash', value: cash },
    { name: 'Online / UPI', value: online },
    ...(addon > 0 ? [{ name: 'Add-ons', value: addon }] : []),
  ].filter((s) => s.value > 0)

  return (
    <section aria-labelledby="sec-financials" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="sec-financials" className="text-[13px] font-semibold tracking-tight text-slate-800 dark:text-slate-100">Financial performance</h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">Payment &amp; expense basis</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total revenue" tone="brand" icon={<BadgeIndianRupee className="size-4" />} value={<Money value={gross} />}
          hint={`Cash ${money(cash)} · UPI ${money(online)}`} />
        <StatCard label="Net profit" tone={netProfit >= 0 ? 'green' : 'red'} icon={<PiggyBank className="size-4" />} value={<Money value={netProfit} />}
          hint={<><Pct value={margin} /> margin</>} />
        <StatCard label="Total expenses" tone="red" icon={<Receipt className="size-4" />} value={<Money value={expenses} />}
          hint={`${money(data.transaction_expense_total)} daily · ${money(data.report_expense_total)} report`} />
        <StatCard label="Avg daily revenue" tone="violet" icon={<CalendarDays className="size-4" />} value={<Money value={avgDaily} />}
          hint={`${days} ${days === 1 ? 'day' : 'days'}`} />
        <StatCard label="Check-ins & renewals" tone="amber" icon={<DoorOpen className="size-4" />} value={<Count value={checkins} />}
          hint={`${renewals} renewals · ${stays} total stays`} />
        <StatCard label="Add-on revenue" tone="cyan" icon={<Wallet className="size-4" />} value={<Money value={addon} />}
          hint={`${data.addon_logs.length} items`} />
        <StatCard label="Refunds" tone="red" icon={<Undo2 className="size-4" />} value={<Money value={refunds} />}
          hint={<>{data.refund_logs.length} txns · <Pct value={refundRate} /> rate</>} />
        <StatCard label="Avg per stay" tone="green" icon={<BadgeIndianRupee className="size-4" />} value={<Money value={avgPerStay} />}
          hint={`${stays} stays`} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Insight icon={<Trophy className="size-4 text-amber-600 dark:text-amber-400" />} tone="bg-amber-100 dark:bg-amber-500/15"
          label="Best revenue day" value={bestDay ? `${ddmm(bestDay[0])} · ${money(bestDay[1])}` : '—'} />
        <Insight icon={<DoorOpen className="size-4 text-sky-600 dark:text-sky-400" />} tone="bg-sky-100 dark:bg-sky-500/15"
          label="Top earning room" value={topRoom ? `${topRoom[0]} · ${money(topRoom[1])}` : '—'} />
        <Insight icon={<ArrowLeftRight className="size-4 text-emerald-600 dark:text-emerald-400" />} tone="bg-emerald-100 dark:bg-emerald-500/15"
          label="Cash vs UPI" value={`${cashPct}% cash · ${100 - cashPct}% UPI`} />
        <Insight icon={<Percent className="size-4 text-teal-600 dark:text-teal-400" />} tone="bg-teal-100 dark:bg-teal-500/15"
          label="Expense ratio" value={`${Number(expRatio.toFixed(1))}% of revenue`} />
      </div>

      <div className="grid gap-3 lg:grid-cols-5">
        <ChartCard className="lg:col-span-3" title="Daily revenue — cash vs UPI">
          {daily.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={daily} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="name" tick={AXIS} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={12} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={compactInr} />
                <Tooltip contentStyle={TIP_STYLE} formatter={(v: number, n) => [money(v), n]} cursor={{ fill: 'rgba(148,163,184,.12)' }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="cash" stackId="r" name="Cash" fill={CASH_COLOR} radius={[0, 0, 0, 0]} maxBarSize={38} animationDuration={800} />
                <Bar dataKey="online" stackId="r" name="Online / UPI" fill={ONLINE_COLOR} radius={[3, 3, 0, 0]} maxBarSize={38} animationDuration={800} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyState title="No revenue in this period" />}
        </ChartCard>

        <ChartCard className="lg:col-span-2" title="Payment split">
          {split.length ? <Donut data={split} colors={[CASH_COLOR, ONLINE_COLOR, ADDON_COLOR]} /> : <EmptyState title="No payments" />}
        </ChartCard>
      </div>

      <ChartCard title="Top rooms by revenue">
        {topRooms.length ? (
          <ResponsiveContainer width="100%" height={Math.max(160, topRooms.length * 44)}>
            <BarChart data={topRooms} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
              <CartesianGrid stroke={GRID} horizontal={false} />
              <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={compactInr} />
              <YAxis type="category" dataKey="name" tick={AXIS} tickLine={false} axisLine={false} width={84} />
              <Tooltip contentStyle={TIP_STYLE} formatter={(v: number) => [money(v), 'Revenue']} cursor={{ fill: 'rgba(148,163,184,.12)' }} />
              <Bar dataKey="value" name="Revenue" fill={NEUTRAL} radius={[0, 3, 3, 0]} maxBarSize={28} animationDuration={800} />
            </BarChart>
          </ResponsiveContainer>
        ) : <EmptyState title="No room revenue" />}
      </ChartCard>
    </section>
  )
}

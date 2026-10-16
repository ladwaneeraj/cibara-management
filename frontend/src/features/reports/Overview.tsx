import { useQuery } from '@tanstack/react-query'
import { Lightbulb } from 'lucide-react'
import { useMemo } from 'react'
import { Card, ErrorState, Skeleton, StatCard } from '@/components/ui'
import { get } from '@/lib/api'
import { money, shortDate } from '@/lib/format'
import { Donut, HBar, StackedDaily } from './charts'
import type { Range } from './FinancePage'

interface Log { amount: number; date: string; method?: string; type?: string; room?: string; item?: string }
interface Exp { amount: number; date: string; category: string; expense_type?: string }
interface Summary {
  cash_total: number; online_total: number; addon_total: number; refund_total: number; expense_total: number
  transaction_expense_total: number; report_expense_total: number; total_revenue: number; renewals: number
  cash_logs: Log[]; online_logs: Log[]; addon_logs: Log[]; refund_logs: Log[]; expense_logs: Exp[]
}
interface Revenue {
  summary: { total_bills: number; total_billed: number; hotel_revenue: number; ota_revenue: number; total_services: number;
    total_discounts: number; total_balance_due: number; invoices_issued: number }
  bills: { room: string; total_amount: number; payment_source?: string }[]
}
interface Insights { insights: { level: string; text: string }[]; totals: { avg_occupancy_pct: number | null } }

export function Overview({ range }: { range: Range }) {
  const s = useQuery({ queryKey: ['rep-summary', range], queryFn: () => get<Summary>('/api/v2/reports/summary', range) })
  const rv = useQuery({ queryKey: ['rep-revenue', range], queryFn: () => get<Revenue>('/api/v2/reports/revenue', range) })
  const ins = useQuery({
    queryKey: ['rep-insights', range],
    queryFn: () => get<Insights>('/api/v2/reports/insights', range),
    enabled: daysBetween(range) <= 92,
    retry: false,
  })

  const daily = useMemo(() => {
    const m = new Map<string, { day: string; cash: number; online: number }>()
    const add = (rows: Log[] | undefined, k: 'cash' | 'online') => {
      for (const r of rows || []) {
        const d = m.get(r.date) || { day: r.date, cash: 0, online: 0 }
        d[k] += Number(r.amount || 0)
        m.set(r.date, d)
      }
    }
    add(s.data?.cash_logs.filter((x) => x.method === 'cash'), 'cash')
    add(s.data?.online_logs, 'online')
    return [...m.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, day: shortDate(d.day) }))
  }, [s.data])

  const expByCat = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of s.data?.expense_logs || []) m.set(e.category || 'other', (m.get(e.category || 'other') || 0) + Number(e.amount || 0))
    return [...m.entries()].map(([name, value]) => ({ name: name.replace(/_/g, ' '), value })).sort((a, b) => b.value - a.value)
  }, [s.data])

  const topRooms = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of rv.data?.bills || []) if (b.payment_source !== 'ota') m.set(b.room, (m.get(b.room) || 0) + Number(b.total_amount || 0))
    return [...m.entries()].map(([name, value]) => ({ name: `Room ${name}`, value })).sort((a, b) => b.value - a.value).slice(0, 10)
  }, [rv.data])

  if (s.error) return <ErrorState error={s.error} onRetry={() => s.refetch()} />
  const d = s.data
  const rs = rv.data?.summary
  const income = (d?.cash_total || 0) + (d?.online_total || 0)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {!d ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />) : (
          <>
            <StatCard label="Collected" value={money(income)} hint={`Cash ${money(d.cash_total)} · Online ${money(d.online_total)}`} tone="brand" />
            <StatCard label="Net (after refunds & daily expenses)" value={money(d.total_revenue)} tone="green" />
            <StatCard label="Expenses" value={money(d.expense_total)} hint={`Daily ${money(d.transaction_expense_total)} · Account ${money(d.report_expense_total)}`} tone="red" />
            <StatCard label="Refunds" value={money(d.refund_total)} hint={`${d.refund_logs.length} refunds`} tone="amber" />
            <StatCard label="Billed (invoices)" value={money(rs?.total_billed)} hint={`${rs?.total_bills ?? 0} bills · ${rs?.invoices_issued ?? 0} GST invoices`} tone="violet" />
            <StatCard label="Direct vs OTA" value={money(rs?.hotel_revenue)} hint={`OTA ${money(rs?.ota_revenue)}`} tone="cyan" />
            <StatCard label="Services / add-ons" value={money(d.addon_total)} hint={`Discounts ${money(rs?.total_discounts)}`} tone="slate" />
            <StatCard label="Balance due on bills" value={money(rs?.total_balance_due)} hint={ins.data?.totals?.avg_occupancy_pct != null ? `Avg occupancy ${ins.data.totals.avg_occupancy_pct}%` : undefined} tone="red" />
          </>
        )}
      </div>

      {ins.data?.insights?.length ? (
        <Card title={<span className="flex items-center gap-2"><Lightbulb className="size-4 text-amber-500" />Highlights</span>}>
          <ul className="grid gap-2 sm:grid-cols-2">{ins.data.insights.slice(0, 6).map((x, i) => (
            <li key={i} className={`rounded-xl px-3 py-2 text-sm ${x.level === 'warn' ? 'bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200' : x.level === 'good' ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200' : 'bg-slate-50 dark:bg-white/5'}`}>{x.text}</li>
          ))}</ul>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Daily collections" className="xl:col-span-2">{s.isLoading ? <Skeleton className="h-64" /> : daily.length ? <StackedDaily data={daily} /> : <p className="py-10 text-center text-sm text-slate-500">No collections in this period.</p>}</Card>
        <Card title="Payment mix">{d ? <Donut colors={['#0d9488', '#2449d8']} data={[{ name: 'Cash', value: d.cash_total }, { name: 'Online', value: d.online_total }]} /> : <Skeleton className="h-60" />}</Card>
        <Card title="Top rooms by billing" className="xl:col-span-2">{rv.isLoading ? <Skeleton className="h-64" /> : topRooms.length ? <HBar data={topRooms} /> : <p className="py-10 text-center text-sm text-slate-500">No bills.</p>}</Card>
        <Card title="Expenses by category">{expByCat.length ? <Donut data={expByCat} /> : <p className="py-10 text-center text-sm text-slate-500">No expenses.</p>}</Card>
      </div>
    </div>
  )
}

export function daysBetween(r: Range) {
  return Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86400000) + 1
}

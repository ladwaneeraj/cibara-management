import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Badge, Card, EmptyState, ErrorState, Segmented, Skeleton, StatCard } from '@/components/ui'
import { get } from '@/lib/api'
import { money, shortDate } from '@/lib/format'
import type { Range } from './FinancePage'

interface P { room?: string; name?: string; amount: number; method?: string; type?: string; date: string; time?: string; note?: string; item?: string; voided?: boolean }
interface E { _doc_id: string; amount: number; date: string; time?: string; category: string; description: string; expense_type?: string; payment_method?: string }
interface Logs { cash: P[]; online: P[]; refunds: P[]; settlements: P[]; expenses: E[] }

type Kind = 'all' | 'cash' | 'online' | 'refund' | 'expense'

const TYPE_LABEL: Record<string, string> = {
  checkin: 'Check-in', payment: 'Payment', renewal: 'Rent', addon: 'Service', settlement_payment: 'Settlement',
  booking_advance: 'Booking advance', booking_payment: 'Booking', booking_conversion: 'Booking check-in',
  manual_refund: 'Refund', checkout_refund: 'Checkout refund', booking_cancel_refund: 'Cancel refund',
}

export function Transactions({ range }: { range: Range }) {
  const [kind, setKind] = useState<Kind>('all')
  const q = useQuery({ queryKey: ['txn', range], queryFn: () => get<{ logs: Logs }>('/api/v2/transactions', range).then((r) => r.logs) })
  const rows = useMemo(() => {
    const d = q.data
    if (!d) return []
    const out: { k: Exclude<Kind, 'all'>; date: string; time: string; title: string; sub: string; amount: number; voided?: boolean }[] = []
    for (const p of d.cash) if (p.method === 'cash') out.push({ k: 'cash', date: p.date, time: p.time || '', title: `${p.room ? `Room ${p.room} · ` : ''}${p.name || ''}`, sub: TYPE_LABEL[p.type || ''] || p.item || p.type || '', amount: p.amount, voided: p.voided })
    for (const p of d.online) out.push({ k: 'online', date: p.date, time: p.time || '', title: `${p.room ? `Room ${p.room} · ` : ''}${p.name || ''}`, sub: TYPE_LABEL[p.type || ''] || p.item || p.type || '', amount: p.amount, voided: p.voided })
    for (const p of d.refunds) out.push({ k: 'refund', date: p.date, time: p.time || '', title: `${p.room ? `Room ${p.room} · ` : ''}${p.name || ''}`, sub: TYPE_LABEL[p.type || ''] || 'Refund', amount: p.amount })
    for (const e of d.expenses) if ((e.expense_type || 'transaction') === 'transaction') out.push({ k: 'expense', date: e.date, time: e.time || '', title: e.description, sub: e.category.replace(/_/g, ' '), amount: e.amount })
    return out.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))
  }, [q.data])
  const sum = (k: Kind) => rows.filter((r) => r.k === k && !r.voided).reduce((s, r) => s + r.amount, 0)
  const shown = rows.filter((r) => kind === 'all' || r.k === kind)
  const days = useMemo(() => {
    const m = new Map<string, typeof shown>()
    for (const r of shown) m.set(r.date, [...(m.get(r.date) || []), r])
    return [...m.entries()]
  }, [shown])

  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {!q.data ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />) : (
          <>
            <StatCard label="Cash" value={money(sum('cash'))} tone="green" />
            <StatCard label="UPI / online" value={money(sum('online'))} tone="brand" />
            <StatCard label="Total in (after refunds)" value={money(sum('cash') + sum('online') - sum('refund'))} hint={`Refunds ${money(sum('refund'))}`} tone="cyan" />
            <StatCard label="Daily expenses" value={money(sum('expense'))} tone="red" />
          </>
        )}
      </div>
      <Segmented<Kind> value={kind} onChange={setKind} size="sm"
        options={[{ value: 'all', label: 'All' }, { value: 'cash', label: 'Cash' }, { value: 'online', label: 'Online' }, { value: 'refund', label: 'Refunds' }, { value: 'expense', label: 'Expenses' }]} />
      <Card padded={false}>
        {!q.data ? <div className="p-4"><Skeleton className="h-64" /></div> : days.length === 0 ? <EmptyState title="No transactions" /> : days.map(([day, list]) => (
          <div key={day}>
            <div className="sticky top-14 z-10 flex justify-between bg-slate-50/95 px-5 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 backdrop-blur dark:bg-ink-900/95">
              <span>{shortDate(day)}</span><span className="num">{list.length} entries</span>
            </div>
            <ul className="divide-y divide-slate-100 dark:divide-white/5">{list.map((r, i) => (
              <li key={i} className={`flex items-center justify-between gap-3 px-5 py-2.5 ${r.voided ? 'opacity-50 line-through' : ''}`}>
                <div className="min-w-0"><div className="truncate text-sm font-medium">{r.title || '—'}</div><div className="text-xs capitalize text-slate-500">{r.time} · {r.sub}</div></div>
                <div className="flex items-center gap-2">
                  <Badge tone={r.k === 'cash' ? 'green' : r.k === 'online' ? 'brand' : r.k === 'refund' ? 'amber' : 'red'}>{r.k}</Badge>
                  <span className={`num w-24 text-right font-semibold ${r.k === 'refund' || r.k === 'expense' ? 'text-rose-600' : ''}`}>{r.k === 'refund' || r.k === 'expense' ? '−' : ''}{money(r.amount)}</span>
                </div>
              </li>
            ))}</ul>
          </div>
        ))}
      </Card>
      <p className="text-xs text-slate-500">Non-admin roles see the last 3 days (same rule as before).</p>
    </div>
  )
}

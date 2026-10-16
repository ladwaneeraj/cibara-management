import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Download, FileText, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/layout/AppShell'
import { Badge, Button, Card, EmptyState, ErrorState, Input, Select, Skeleton, StatCard, Tabs } from '@/components/ui'
import { get } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { addDays, cls, istDate, money, monthStart, stamp } from '@/lib/format'
import type { BillRow, BillsPage as Page, BillsSummary } from '@/lib/types'
import { BillDrawer } from './BillDrawer'
import { CreditNotes } from './CreditNotes'

type Preset = 'today' | '3d' | 'month' | 'custom'

export function useDebounced<T>(v: T, ms = 250): T {
  const [d, setD] = useState(v)
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t) }, [v, ms])
  return d
}

export function rangeFor(p: Preset, custom: { start: string; end: string }) {
  const today = istDate()
  if (p === 'today') return { start: today, end: today }
  if (p === '3d') return { start: addDays(today, -2), end: today }
  if (p === 'month') return { start: monthStart(today), end: today }
  return custom
}

export function statusPills(b: BillRow) {
  const pills: { tone: Parameters<typeof Badge>[0]['tone']; text: string; title?: string }[] = []
  if (b.status === 'cancelled') pills.push({ tone: 'red', text: b.superseded_by_revert ? 'Reverted' : 'Cancelled', title: b.cancel_reason || undefined })
  if (b.status === 'pending_settlement') pills.push({ tone: 'amber', text: 'Settle later' })
  else if (b.balance > 0 && b.status !== 'cancelled') pills.push({ tone: 'amber', text: 'Due' })
  if (b.invoice_type === 'B2B') pills.push({ tone: 'violet', text: 'B2B' })
  if (b.is_cancellation_charge) pills.push({ tone: 'slate', text: 'Cancel charge' })
  if (b.booking_source && b.booking_source !== 'normal') pills.push({ tone: 'cyan', text: b.booking_source.toUpperCase() })
  return pills
}

export function BillsPage() {
  const isAdmin = useAuth((s) => s.user?.role === 'admin')
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<'bills' | 'cn'>('bills')
  const [preset, setPreset] = useState<Preset>('3d')
  const [custom, setCustom] = useState({ start: addDays(istDate(), -6), end: istDate() })
  const [q, setQ] = useState('')
  const [type, setType] = useState('all')
  const [payment, setPayment] = useState('all')
  const range = rangeFor(preset, custom)
  const dq = useDebounced(q)
  const openId = params.get('open')

  const filters = { start: range.start, end: range.end, q: dq, type, payment }
  const list = useInfiniteQuery({
    queryKey: ['bills', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => get<Page>('/api/v2/bills', { ...filters, limit: 50, cursor: pageParam }, signal),
    getNextPageParam: (last) => last.next_cursor,
    enabled: tab === 'bills',
  })
  const summary = useQuery({
    queryKey: ['bills-summary', range.start, range.end],
    queryFn: ({ signal }) => get<{ summary: BillsSummary }>('/api/v2/bills/summary', range, signal).then((r) => r.summary),
    enabled: tab === 'bills',
    staleTime: 60_000,
  })
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.bills) ?? [], [list.data])
  const clamped = list.data?.pages[0]?.range
  const s = summary.data

  const exportCsv = () => {
    const head = ['Bill No', 'Status', 'Guest', 'Mobile', 'Room', 'Check-in', 'Check-out', 'Days', 'Total', 'Taxable', 'GST', 'Cash', 'Online', 'Balance', 'Type', 'GSTIN']
    const lines = rows.map((b) => [b.bill_number, b.status, b.guest_name, b.guest_mobile, b.room, b.checkin_time, b.checkout_time, b.days_stayed,
      b.total_amount, b.gst.taxable, b.gst.tax, b.payment_cash, b.payment_online, b.balance, b.invoice_type, b.recipient_gstin]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `bills_${range.start}_${range.end}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div>
      <PageHeader title="Bills" subtitle={`${stamp(range.start)} – ${stamp(range.end)}${clamped && clamped.from !== range.start ? ' (limited to the last 3 days for your role)' : ''}`}
        actions={isAdmin && tab === 'bills' ? <Button variant="secondary" size="sm" icon={<Download className="size-4" />} onClick={exportCsv} disabled={!rows.length}>Export loaded</Button> : null} />

      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'bills', label: 'Invoices' }, { value: 'cn', label: 'Credit notes' }]} />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Select aria-label="Date range" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className="w-auto">
          <option value="today">Today</option>
          <option value="3d">Last 3 days</option>
          {isAdmin && <option value="month">This month</option>}
          {isAdmin && <option value="custom">Custom…</option>}
        </Select>
        {preset === 'custom' && (
          <>
            <Input type="date" aria-label="From" value={custom.start} max={custom.end} onChange={(e) => setCustom({ ...custom, start: e.target.value })} className="w-auto" />
            <Input type="date" aria-label="To" value={custom.end} min={custom.start} max={istDate()} onChange={(e) => setCustom({ ...custom, end: e.target.value })} className="w-auto" />
          </>
        )}
        {tab === 'bills' && (
          <>
            <div className="relative min-w-52 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input aria-label="Search bills" placeholder="Bill no, guest, mobile, room" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
            </div>
            <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className="w-auto">
              <option value="all">All types</option><option value="b2c">B2C</option><option value="b2b">B2B</option>
              <option value="settle_later">Settle later</option><option value="cancelled">Cancelled</option>
              <option value="cancel_charge">Cancellation charge</option><option value="reverted">Reverted</option>
            </Select>
            <Select aria-label="Payment" value={payment} onChange={(e) => setPayment(e.target.value)} className="w-auto">
              <option value="all">All payments</option><option value="cash">Cash only</option><option value="online">Online only</option>
              <option value="split">Split</option><option value="pending">Balance due</option>
            </Select>
          </>
        )}
      </div>

      {tab === 'cn' ? <CreditNotes start={range.start} end={range.end} /> : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {summary.isLoading || !s ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />) : (
              <>
                <StatCard label="Cash" value={money(s.cash)} tone="green" />
                <StatCard label="UPI / online" value={money(s.online)} tone="cyan" />
                <StatCard label="Revenue (settled)" value={money(s.revenue)} tone="brand" />
                <StatCard label="Invoices" value={s.invoices} hint={`${s.b2b} B2B · ${s.cancelled} cancelled`} tone="slate" />
                <StatCard label="Pending due" value={money(s.pending_amount)} hint={`${s.pending_count} bills`} tone="amber" />
                <StatCard label="GST collected" value={money(s.gst)} hint={`Rooms ${money(s.gst_accommodation)} · Other ${money(s.gst_services)}`} tone="accent" />
              </>
            )}
          </div>

          <Card className="mt-4" padded={false}>
            {list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : list.isLoading ? (
              <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : rows.length === 0 ? <EmptyState title="No bills in this range" icon={<FileText className="size-6" />} hint="Try a wider date range or clear the filters." /> : (
              <>
                {/* desktop table */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-sm">
                    <thead className="border-b border-slate-200 bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500 dark:border-white/10 dark:bg-ink-800/60">
                      <tr>
                        <th className="px-4 py-2.5 font-semibold">Bill</th><th className="px-3 py-2.5 font-semibold">Guest</th><th className="px-3 py-2.5 font-semibold">Room</th>
                        <th className="px-3 py-2.5 font-semibold">Stay</th><th className="px-3 py-2.5 text-right font-semibold">Total</th>
                        <th className="px-3 py-2.5 text-right font-semibold">GST</th><th className="px-3 py-2.5 font-semibold">Payment</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                      {rows.map((b) => (
                        <tr key={b.id} onClick={() => setParams({ open: b.id })} className={cls('cursor-pointer odd:bg-white even:bg-slate-50/50 hover:bg-brand-50/60 dark:odd:bg-transparent dark:even:bg-white/[0.015] dark:hover:bg-white/[0.04]', b.status === 'cancelled' && 'opacity-60')}>
                          <td className="px-4 py-3">
                            <div className="num font-medium">{b.bill_number}</div>
                            <div className="mt-1 flex flex-wrap gap-1">{statusPills(b).map((p, i) => <Badge key={i} tone={p.tone} title={p.title}>{p.text}</Badge>)}</div>
                          </td>
                          <td className="px-3 py-3"><div className="font-medium">{b.guest_name}</div><div className="num text-xs text-slate-500">{b.guest_mobile}</div></td>
                          <td className="num px-3 py-3">{b.room}</td>
                          <td className="px-3 py-3 text-xs text-slate-500"><div>{stamp(b.checkin_time)}</div><div>{stamp(b.checkout_time)} · {b.days_stayed}n</div></td>
                          <td className={cls('num px-3 py-3 text-right font-semibold', b.status === 'cancelled' && 'line-through')}>{money(b.total_amount)}</td>
                          <td className="num px-3 py-3 text-right"><div>{b.gst.label === '-' ? '—' : money(b.gst.tax)}</div><div className="text-xs text-slate-500">{b.gst.label}</div></td>
                          <td className="px-3 py-3 text-xs">
                            {b.payment_cash > 0 && <div className="num">Cash {money(b.payment_cash)}</div>}
                            {b.payment_online > 0 && <div className="num">UPI {money(b.payment_online)}</div>}
                            {b.balance > 0 && b.status !== 'cancelled' && <div className="num font-semibold text-rose-600">Due {money(b.balance)}</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* mobile cards */}
                <ul className="divide-y divide-slate-100 md:hidden dark:divide-white/5">
                  {rows.map((b) => (
                    <li key={b.id}>
                      <button type="button" onClick={() => setParams({ open: b.id })} className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left">
                        <div className="min-w-0">
                          <div className="num text-sm font-medium">{b.bill_number} · Room {b.room}</div>
                          <div className="truncate text-sm">{b.guest_name}</div>
                          <div className="mt-1 flex flex-wrap gap-1">{statusPills(b).map((p, i) => <Badge key={i} tone={p.tone}>{p.text}</Badge>)}</div>
                        </div>
                        <div className="text-right">
                          <div className={cls('num font-semibold', b.status === 'cancelled' && 'line-through')}>{money(b.total_amount)}</div>
                          <div className="text-xs text-slate-500">{stamp(b.checkout_time)}</div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
                {list.hasNextPage && (
                  <div className="border-t border-slate-100 p-3 text-center dark:border-white/5">
                    <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Load more</Button>
                  </div>
                )}
              </>
            )}
          </Card>
        </>
      )}

      <BillDrawer billId={openId} onClose={() => { params.delete('open'); setParams(params) }} />
    </div>
  )
}

/**
 * Reports — the classic "Reports" tab, rebuilt: a transaction report (every
 * cash/online/add-on/refund/expense entry, filterable + searchable + CSV
 * export) and a GSTR-1 summary. Data: POST /reports (already fetched for the
 * Financial section) + POST /reports/gstr1_summary.
 */
import { useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { Button, EmptyState, Skeleton, StatCard } from '@/components/ui'
import { money } from '@/lib/format'
import { ChartCard } from '../Panel'
import type { FinancialsReport, Gstr1Summary, PaymentLog } from '../types'

type Kind = 'cash' | 'online' | 'addon' | 'refund' | 'expense'
interface Txn { date: string; kind: Kind; amount: number; who: string; room: string; detail: string }

const KIND_LABEL: Record<Kind, string> = { cash: 'Cash', online: 'Online / UPI', addon: 'Add-on', refund: 'Refund', expense: 'Expense' }

function collect(data: FinancialsReport): Txn[] {
  const out: Txn[] = []
  const push = (logs: PaymentLog[], kind: Kind) => {
    for (const p of logs) {
      out.push({
        date: (p.date || '').trim(),
        kind,
        amount: Number(p.amount || 0),
        who: (p.name || '').trim(),
        room: p.room != null && p.room !== '' ? String(p.room) : '',
        detail: (p.type || '').trim(),
      })
    }
  }
  push(data.cash_logs, 'cash')
  push(data.online_logs, 'online')
  push(data.addon_logs, 'addon')
  push(data.refund_logs, 'refund')
  push(data.expense_logs, 'expense')
  return out
}

type SortKey = 'new' | 'old' | 'high' | 'low'
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'new', label: 'Newest' }, { key: 'old', label: 'Oldest' },
  { key: 'high', label: 'Highest' }, { key: 'low', label: 'Lowest' },
]

function toCsv(rows: Txn[]): string {
  const head = ['Date', 'Type', 'Detail', 'Room', 'Guest/Vendor', 'Amount']
  const esc = (v: string | number) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = rows.map((r) => [r.date, KIND_LABEL[r.kind], r.detail, r.room, r.who, r.amount].map(esc).join(','))
  return [head.join(','), ...lines].join('\n')
}

function downloadCsv(rows: Txn[]) {
  try {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch { /* export is best-effort */ }
}

function GstrSummary({ gstr, loading }: { gstr?: Gstr1Summary; loading: boolean }) {
  if (loading && !gstr) return <Skeleton className="h-48" />
  if (!gstr) return <EmptyState title="GSTR-1 unavailable" />
  const rates = Object.entries(gstr.rate_summary || {}).sort((a, b) => Number(a[0]) - Number(b[0]))
  const t = gstr.totals
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Invoices" tone="brand" value={t.invoices} />
        <StatCard label="Taxable value" tone="violet" value={money(t.taxable)} />
        <StatCard label="CGST + SGST" tone="green" value={money(t.cgst + t.sgst)} hint={`IGST ${money(t.igst)}`} />
        <StatCard label="Invoice value" tone="cyan" value={money(t.invoice_value)} />
      </div>
      <div className="overflow-x-auto">
        <table className="table-erp w-full text-sm">
          <thead>
            <tr>
              <th className="text-left">GST rate</th>
              <th className="text-right">Taxable</th>
              <th className="text-right">CGST</th>
              <th className="text-right">SGST</th>
              <th className="text-right">IGST</th>
            </tr>
          </thead>
          <tbody>
            {rates.map(([rate, r]) => (
              <tr key={rate}>
                <td>{rate}%</td>
                <td className="text-right tabular-nums">{money(r.taxable)}</td>
                <td className="text-right tabular-nums">{money(r.cgst)}</td>
                <td className="text-right tabular-nums">{money(r.sgst)}</td>
                <td className="text-right tabular-nums">{money(r.igst)}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td>Total</td>
              <td className="text-right tabular-nums">{money(t.taxable)}</td>
              <td className="text-right tabular-nums">{money(t.cgst)}</td>
              <td className="text-right tabular-nums">{money(t.sgst)}</td>
              <td className="text-right tabular-nums">{money(t.igst)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        B2B {gstr.b2b.length} · B2C large {gstr.b2cl.length} · B2C small {gstr.b2cs.length} · credit notes {gstr.credit_notes.length}.
        For the full GSTR-1/3B Excel workbook, use <a className="text-brand-700 hover:underline dark:text-brand-300" href="/?view=reports">classic reports</a>.
      </p>
    </div>
  )
}

export function Reports({ data, gstr, gstrLoading }: { data?: FinancialsReport; gstr?: Gstr1Summary; gstrLoading: boolean }) {
  const [filter, setFilter] = useState<Kind | 'all'>('all')
  const [sort, setSort] = useState<SortKey>('new')
  const [q, setQ] = useState('')

  const all = useMemo(() => (data ? collect(data) : []), [data])
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length, cash: 0, online: 0, addon: 0, refund: 0, expense: 0 }
    for (const r of all) c[r.kind]++
    return c
  }, [all])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let r = all.filter((t) => (filter === 'all' || t.kind === filter)
      && (!needle || `${t.room} ${t.who} ${t.detail}`.toLowerCase().includes(needle)))
    r = [...r].sort((a, b) =>
      sort === 'new' ? b.date.localeCompare(a.date)
        : sort === 'old' ? a.date.localeCompare(b.date)
          : sort === 'high' ? b.amount - a.amount
            : a.amount - b.amount)
    return r
  }, [all, filter, sort, q])

  if (!data) {
    return <ChartCard title="Transactions"><EmptyState title="No report data" hint="No transactions for this period." /></ChartCard>
  }

  const cash = Number(data.cash_total || 0)
  const online = Number(data.online_total || 0)
  const expenses = Number(data.expense_total || 0)
  const refunds = Number(data.refund_total || 0)
  const net = cash + online - refunds - expenses

  const chips: { key: Kind | 'all'; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'cash', label: 'Cash' }, { key: 'online', label: 'Online' },
    { key: 'addon', label: 'Add-ons' }, { key: 'expense', label: 'Expenses' }, { key: 'refund', label: 'Refunds' },
  ]

  return (
    <section aria-labelledby="sec-reports" className="space-y-4">
      <h2 id="sec-reports" className="sr-only">Reports</h2>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Cash" tone="green" value={money(cash)} hint={`${counts.cash} entries`} />
        <StatCard label="Online / UPI" tone="brand" value={money(online)} hint={`${counts.online} entries`} />
        <StatCard label="Expenses" tone="red" value={money(expenses)} hint={`${counts.expense} entries`} />
        <StatCard label="Refunds" tone="amber" value={money(refunds)} hint={`${counts.refund} entries`} />
        <StatCard label="Net" tone="violet" value={money(net)} hint="cash + online − refunds − expenses" />
      </div>

      <ChartCard
        title="Transactions"
        action={
          <Button variant="secondary" size="sm" onClick={() => downloadCsv(rows)} disabled={!rows.length}>
            <Download className="size-4" aria-hidden /> Export CSV
          </Button>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setFilter(c.key)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  filter === c.key
                    ? 'border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-400/40 dark:bg-brand-500/15 dark:text-brand-200'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-white/5'
                }`}
              >
                {c.label} <span className="opacity-60">{counts[c.key]}</span>
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search room, guest, type…"
              className="w-44 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-400 dark:border-white/10 dark:bg-ink-900"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand-400 dark:border-white/10 dark:bg-ink-900"
            >
              {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
        </div>

        {rows.length ? (
          <div className="max-h-[28rem] overflow-auto">
            <table className="table-erp w-full text-sm">
              <thead className="sticky top-0">
                <tr>
                  <th className="text-left">Date</th>
                  <th className="text-left">Type</th>
                  <th className="text-left">Detail</th>
                  <th className="text-left">Room</th>
                  <th className="text-left">Guest / vendor</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="whitespace-nowrap">{r.date || '—'}</td>
                    <td>{KIND_LABEL[r.kind]}</td>
                    <td className="text-slate-500 dark:text-slate-400">{r.detail || '—'}</td>
                    <td>{r.room || '—'}</td>
                    <td className="max-w-40 truncate">{r.who || '—'}</td>
                    <td className={`text-right tabular-nums ${r.kind === 'refund' || r.kind === 'expense' ? 'text-rose-600 dark:text-rose-400' : ''}`}>
                      {r.kind === 'refund' || r.kind === 'expense' ? '−' : ''}{money(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="No matching transactions" />}
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{rows.length} of {all.length} transactions</p>
      </ChartCard>

      <ChartCard title="GSTR-1 summary">
        <GstrSummary gstr={gstr} loading={gstrLoading} />
      </ChartCard>
    </section>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Receipt, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, Segmented, Select, Skeleton, StatCard } from '@/components/ui'
import { del, get, post } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { istDate, money, shortDate } from '@/lib/format'
import { confirmDialog, toast } from '@/lib/ui'
import type { Range } from './FinancePage'

interface E { _doc_id: string; date: string; time?: string; category: string; description: string; amount: number; expense_type?: string; payment_method?: string; has_gst?: boolean; split_group_id?: string; created_by?: { name?: string } }
interface Browse { expense_total: number; transaction_expense_total: number; report_expense_total: number; expense_logs: E[] }

const CATS = ['utilities', 'petty_cash', 'purchase', 'maintenance', 'sanitary', 'salary', 'booking_commission', 'others', 'marketing']

export function Expenses({ range }: { range: Range }) {
  const canAdd = useCan('register.view')
  const canManage = useCan('expense.manage')
  const canMarketing = useCan('expense.marketing')
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const q = useQuery({ queryKey: ['expenses', range], queryFn: () => get<Browse>('/api/v2/expenses', range) })
  const remove = useMutation({
    mutationFn: (id: string) => del<{ message: string }>(`/api/v2/expenses/${id}`),
    onSuccess: (r) => { toast(r.message); void qc.invalidateQueries({ queryKey: ['expenses'] }) },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'error'),
  })
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const rows = [...(q.data?.expense_logs || [])].sort((a, b) => `${b.date} ${b.time || ''}`.localeCompare(`${a.date} ${a.time || ''}`))
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid flex-1 grid-cols-3 gap-3">
          {!q.data ? Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24" />) : (
            <>
              <StatCard label="All expenses" value={money(q.data.expense_total)} tone="red" />
              <StatCard label="Daily (counter)" value={money(q.data.transaction_expense_total)} tone="amber" />
              <StatCard label="From account / home" value={money(q.data.report_expense_total)} tone="slate" />
            </>
          )}
        </div>
        {canAdd && <Button icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Add expense</Button>}
      </div>
      <Card padded={false}>
        {!q.data ? <div className="p-4"><Skeleton className="h-48" /></div> : rows.length === 0 ? <EmptyState title="No expenses" icon={<Receipt className="size-6" />} /> : (
          <ul className="divide-y divide-slate-100 dark:divide-white/5">{rows.map((e) => (
            <li key={e._doc_id} className="flex items-center justify-between gap-3 px-5 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{e.description}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  {shortDate(e.date)} {e.time} · <span className="capitalize">{e.category.replace(/_/g, ' ')}</span>
                  <Badge tone={(e.expense_type || 'transaction') === 'transaction' ? 'amber' : 'slate'}>{(e.expense_type || 'transaction') === 'transaction' ? 'Daily' : 'Account'}</Badge>
                  {e.has_gst && <Badge tone="violet">GST</Badge>}{e.split_group_id && <Badge tone="cyan">Split</Badge>}
                  {e.created_by?.name && <span>· {e.created_by.name}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="num font-semibold">{money(e.amount)}</span>
                {canManage && (
                  <button type="button" aria-label="Delete expense" className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                    onClick={async () => { if (await confirmDialog({ title: 'Delete expense?', message: `${e.description} · ${money(e.amount)}`, confirmLabel: 'Delete', danger: true })) remove.mutate(e._doc_id) }}>
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            </li>
          ))}</ul>
        )}
      </Card>
      {open && <AddExpense onClose={() => setOpen(false)} cats={CATS.filter((c) => c !== 'marketing' || canMarketing)} />}
      <p className="text-xs text-slate-500">Staff advances, salary payouts and invoice OCR are still handled on the classic Expense screen.</p>
    </div>
  )
}

function AddExpense({ onClose, cats }: { onClose: () => void; cats: string[] }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ date: istDate(), category: 'utilities', description: '', amount: '', type: 'transaction' as 'transaction' | 'report', method: 'cash' as 'cash' | 'online' })
  const m = useMutation({
    mutationFn: () => post<{ message: string }>('/api/v2/expenses', {
      date: f.date, category: f.category, description: f.description.trim(), amount: Number(f.amount),
      type: f.type, payment_method: f.type === 'transaction' ? 'cash' : f.method,
    }),
    onSuccess: (r) => { toast(r.message || 'Expense added'); void qc.invalidateQueries({ queryKey: ['expenses'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); onClose() },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'error'),
  })
  return (
    <Modal open onClose={onClose} title="Add expense"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!f.description.trim() || !(Number(f.amount) > 0)} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="space-y-3">
        <Segmented value={f.type} onChange={(v) => setF({ ...f, type: v })} className="w-full"
          options={[{ value: 'transaction', label: 'Daily (counter cash)' }, { value: 'report', label: 'From account / home' }]} />
        {f.type === 'report' && <Segmented value={f.method} onChange={(v) => setF({ ...f, method: v })} className="w-full" options={[{ value: 'cash', label: 'Home cash' }, { value: 'online', label: 'From account' }]} />}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date"><Input type="date" value={f.date} max={istDate()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Amount"><Input type="number" min={1} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        </div>
        <Field label="Category">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {cats.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
          </Select>
        </Field>
        <Field label="Description"><Input value={f.description} maxLength={300} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
    </Modal>
  )
}

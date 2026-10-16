import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HandCoins } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, Notice, Segmented, Skeleton, StatCard, Textarea } from '@/components/ui'
import { ApiError, get, post } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { istDate, money, shortDate } from '@/lib/format'
import { toast } from '@/lib/ui'

interface S {
  id: string; guest_name: string; guest_mobile: string; room: string; amount: number; checkout_date: string
  status: string; notes?: string; payments?: { amount?: number; discount?: number; date: string; mode?: string }[]
  bill?: { bill_number?: string; total_amount?: number; paid?: number }
}

type Status = 'open' | 'paid' | 'cancelled' | 'all'

export function Settlements() {
  const [status, setStatus] = useState<Status>('open')
  const [collect, setCollect] = useState<S | null>(null)
  const canCancel = useCan('settlement.manage')
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['settlements', status], queryFn: () => get<{ settlements: S[]; total_due: number; count: number }>('/api/v2/settlements', { status }) })
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => post<{ message: string }>(`/api/v2/settlements/${id}/cancel`, { reason }),
    onSuccess: (r) => { toast(r.message); void qc.invalidateQueries({ queryKey: ['settlements'] }) },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'error'),
  })
  const oldest = (q.data?.settlements || []).reduce((m, s) => (s.checkout_date && s.checkout_date < m ? s.checkout_date : m), istDate())
  return (
    <div className="space-y-4">
      {status === 'open' && q.data && (
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Total due" value={money(q.data.total_due)} tone="red" />
          <StatCard label="Guests" value={q.data.count} tone="amber" />
          <StatCard label="Oldest" value={q.data.count ? shortDate(oldest) : '—'} tone="slate" />
        </div>
      )}
      <Segmented<Status> value={status} onChange={setStatus} size="sm"
        options={[{ value: 'open', label: 'Pending' }, { value: 'paid', label: 'Paid' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'all', label: 'All' }]} />
      <Card padded={false}>
        {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <div className="p-4"><Skeleton className="h-48" /></div>
          : q.data.settlements.length === 0 ? <EmptyState title="Nothing here" icon={<HandCoins className="size-6" />} /> : (
            <ul className="divide-y divide-slate-100 dark:divide-white/5">{q.data.settlements.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <div className="font-medium">{s.guest_name} <span className="num text-sm text-slate-500">· {s.guest_mobile}</span></div>
                  <div className="text-xs text-slate-500">Room {s.room} · checked out {shortDate(s.checkout_date)}{s.bill?.bill_number ? ` · ${s.bill.bill_number}` : ''}</div>
                  {s.notes && <div className="mt-1 text-xs text-slate-600 dark:text-slate-300">“{s.notes}”</div>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={s.status === 'paid' ? 'green' : s.status === 'cancelled' ? 'slate' : s.status === 'partial' ? 'amber' : 'red'}>{s.status}</Badge>
                  <span className="num w-24 text-right font-semibold">{money(s.amount)}</span>
                  {(s.status === 'pending' || s.status === 'partial') && <Button size="sm" variant="success" onClick={() => setCollect(s)}>Collect</Button>}
                  {canCancel && s.status === 'pending' && (
                    <Button size="sm" variant="ghost" onClick={() => { const reason = window.prompt('Reason for writing this off?'); if (reason && reason.trim().length >= 3) cancel.mutate({ id: s.id, reason: reason.trim() }) }}>Cancel</Button>
                  )}
                </div>
              </li>
            ))}</ul>
          )}
      </Card>
      {collect && <CollectDialog s={collect} onClose={() => setCollect(null)} />}
    </div>
  )
}

function CollectDialog({ s, onClose }: { s: S; onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ amount: String(s.amount), mode: 'cash' as 'cash' | 'online', date: '', discount: '', reason: '', dtype: 'financial' as 'financial' | 'credit_note' })
  const [s34, setS34] = useState<string | null>(null)
  const m = useMutation({
    mutationFn: (ack: boolean) => post<{ message: string }>(`/api/v2/settlements/${s.id}/collect`, {
      payment_mode: f.mode, payment_amount: Number(f.amount || 0), payment_date: f.date,
      discount_amount: Number(f.discount || 0), discount_reason: f.reason, discount_type: f.dtype, acknowledge_section34_window: ack,
    }),
    onSuccess: (r) => { toast(r.message || 'Collected'); void qc.invalidateQueries({ queryKey: ['settlements'] }); onClose() },
    onError: (e) => {
      // Known legacy behaviour (documented in CLAUDE.md): the payment is
      // committed BEFORE the Section 34 check answers 409, so a retry would
      // hit ALREADY_PAID. Show the warning and reload instead of retrying.
      if (e instanceof ApiError && (e.body as { section34_warning?: boolean })?.section34_warning) {
        setS34(`${e.message} The payment itself may already be recorded — check the list before trying again.`)
        void qc.invalidateQueries({ queryKey: ['settlements'] })
      } else toast(e instanceof Error ? e.message : 'Failed', 'error')
    },
  })
  return (
    <Modal open onClose={onClose} title={`Collect from ${s.guest_name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="success" loading={m.isPending} disabled={!!s34} onClick={() => m.mutate(false)}>{`Collect ${money(Number(f.amount || 0))}`}</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-500">Outstanding <span className="num font-semibold text-rose-600">{money(s.amount)}</span>. Leave the amount as is to settle in full.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount"><Input type="number" min={0} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Received on" hint="Empty = today"><Input type="date" value={f.date} max={istDate()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        </div>
        <Segmented value={f.mode} onChange={(v) => setF({ ...f, mode: v })} className="w-full" options={[{ value: 'cash', label: 'Cash' }, { value: 'online', label: 'Online / UPI' }]} />
        <details className="rounded-xl border border-slate-200 px-3 py-2 dark:border-white/10">
          <summary className="cursor-pointer text-sm">Discount</summary>
          <div className="space-y-3 py-3">
            <Field label="Discount"><Input type="number" min={0} value={f.discount} onChange={(e) => setF({ ...f, discount: e.target.value })} /></Field>
            <Segmented value={f.dtype} onChange={(v) => setF({ ...f, dtype: v })} className="w-full" options={[{ value: 'financial', label: 'Financial' }, { value: 'credit_note', label: 'Credit note' }]} />
            <Field label="Reason"><Textarea value={f.reason} maxLength={300} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          </div>
        </details>
        {s34 && <Notice tone="amber">{s34}</Notice>}
      </div>
    </Modal>
  )
}

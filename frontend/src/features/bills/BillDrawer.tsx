import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Ban, Building2, FileDown, History, IndianRupee, MessageCircle, Pencil, Printer, RefreshCw,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { Badge, Button, Drawer, ErrorState, Field, Input, Modal, Notice, Segmented, Select, Skeleton, Textarea, Toggle } from '@/components/ui'
import { ApiError, get, patch, post } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { istDate, money, money2, stamp } from '@/lib/format'
import { toast } from '@/lib/ui'
import billCss from './bill-preview.css?raw'

interface TaxRow { hsn: string; description: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number; tax: number }
interface Bill {
  id: string; bill_number: string; status: string; guest_name: string; guest_mobile: string; room: string
  checkin_time: string; checkout_time: string; days_stayed: number; total_amount: number; balance: number
  payment_cash: number; payment_online: number; payment_ota?: number; invoice_type?: string; recipient_gstin?: string
  recipient_legal_name?: string; recipient_trade_name?: string; recipient_address?: string; pdf_url?: string
  cancel_reason?: string; linked_credit_note_ids?: string[]; superseded_by_revert?: boolean
  tax_breakup?: { rows: TaxRow[]; taxable: number; tax: number; cgst: number; sgst: number }
}

function srcdoc(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${billCss}</style></head><body>${html}</body></html>`
}

function useInvalidate() {
  const qc = useQueryClient()
  return (id: string) => {
    void qc.invalidateQueries({ queryKey: ['bill', id] })
    void qc.invalidateQueries({ queryKey: ['bill-html', id] })
    void qc.invalidateQueries({ queryKey: ['bills'] })
    void qc.invalidateQueries({ queryKey: ['bills-summary'] })
  }
}

export function BillDrawer({ billId, onClose }: { billId: string | null; onClose: () => void }) {
  const [view, setView] = useState<'consolidated' | 'detailed'>(() => {
    try { return (localStorage.getItem('cibara_bill_view') as 'detailed') || 'consolidated' } catch { return 'consolidated' }
  })
  const frame = useRef<HTMLIFrameElement>(null)
  const canGuest = useCan('bill.guest.edit')
  const canGst = useCan('bill.gst.edit')
  const canPay = useCan('payment.edit')
  const canCancel = useCan('bill.cancel')
  const invalidate = useInvalidate()
  const [dialog, setDialog] = useState<null | 'guest' | 'gst' | 'pay' | 'cancel' | 'wa' | 'log'>(null)

  const bill = useQuery({
    queryKey: ['bill', billId],
    enabled: !!billId,
    queryFn: () => get<{ bill: Bill }>(`/api/v2/bills/${billId}`).then((r) => r.bill),
  })
  const html = useQuery({
    queryKey: ['bill-html', billId, view],
    enabled: !!billId,
    queryFn: () => get<{ html: string; collapsible: boolean; view: string }>(`/api/v2/bills/${billId}/html`, { view }),
  })
  const pdf = useMutation({
    mutationFn: (force: boolean) => post<{ pdf_url: string; skipped?: boolean }>(`/api/v2/bills/${billId}/pdf`, { force }),
    onSuccess: (r, force) => { if (force) toast('PDF regenerated'); invalidate(billId!); window.open(r.pdf_url, '_blank', 'noopener') },
    onError: (e) => toast(e instanceof Error ? e.message : 'PDF failed', 'error'),
  })

  if (!billId) return null
  const b = bill.data
  const cancelled = b?.status === 'cancelled'

  const print = () => {
    frame.current?.contentWindow?.print()
    void post(`/api/v2/bills/${billId}/activity`, { kind: 'print' }).catch(() => {})
  }

  return (
    <Drawer open onClose={onClose} width="max-w-3xl"
      title={<span className="flex items-center gap-2"><span className="num">{b?.bill_number ?? 'Bill'}</span>{b && <Badge tone={cancelled ? 'red' : b.status === 'pending_settlement' ? 'amber' : 'green'}>{cancelled ? 'Cancelled' : b.status === 'pending_settlement' ? 'Settle later' : 'Paid'}</Badge>}</span>}
      subtitle={b ? `${b.guest_name} · Room ${b.room} · ${stamp(b.checkout_time)}` : undefined}
      footer={b && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Printer className="size-4" />} onClick={print}>Print</Button>
          <Button variant="secondary" icon={<FileDown className="size-4" />} loading={pdf.isPending} onClick={() => pdf.mutate(false)}>PDF</Button>
          <Button variant="secondary" icon={<MessageCircle className="size-4" />} onClick={() => setDialog('wa')}>WhatsApp</Button>
          <Button variant="ghost" icon={<History className="size-4" />} onClick={() => setDialog('log')}>Activity</Button>
          <div className="flex-1" />
          {canPay && b.balance > 0 && !cancelled && <Button variant="success" icon={<IndianRupee className="size-4" />} onClick={() => setDialog('pay')}>Collect</Button>}
          {canCancel && !cancelled && !b.superseded_by_revert && <Button variant="danger" icon={<Ban className="size-4" />} onClick={() => setDialog('cancel')}>Cancel bill</Button>}
        </div>
      )}>
      {bill.error ? <ErrorState error={bill.error} onRetry={() => bill.refetch()} /> : !b ? <Skeleton className="h-96" /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Mini label="Total" value={money(b.total_amount)} />
            <Mini label="Taxable" value={money2(b.tax_breakup?.taxable)} />
            <Mini label="GST" value={money2(b.tax_breakup?.tax)} />
            <Mini label={b.balance > 0 ? 'Balance due' : 'Paid'} value={money(b.balance > 0 ? b.balance : b.payment_cash + b.payment_online + (b.payment_ota || 0))} accent={b.balance > 0 ? 'text-rose-600' : 'text-emerald-600'} />
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button type="button" disabled={!canGuest || cancelled} onClick={() => setDialog('guest')}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-slate-100 disabled:opacity-60 dark:hover:bg-white/5">
              <Pencil className="size-3.5" />{b.guest_name} · <span className="num">{b.guest_mobile || 'no mobile'}</span>
            </button>
            <button type="button" disabled={!canGst || cancelled} onClick={() => setDialog('gst')}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-slate-100 disabled:opacity-60 dark:hover:bg-white/5">
              <Building2 className="size-3.5" />{b.invoice_type === 'B2B' ? `${b.recipient_legal_name} · ${b.recipient_gstin}` : 'B2C — add company GSTIN'}
            </button>
            {html.data?.collapsible && (
              <Segmented size="sm" className="ml-auto" value={view} onChange={(v) => { setView(v); try { localStorage.setItem('cibara_bill_view', v) } catch { /* ignore */ } }}
                options={[{ value: 'consolidated', label: 'Consolidated' }, { value: 'detailed', label: 'Day by day' }]} />
            )}
          </div>
          {cancelled && b.cancel_reason && <Notice tone="red">Cancelled: {b.cancel_reason}</Notice>}

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-white/10">
            {html.isLoading ? <Skeleton className="h-[640px] rounded-none" /> : html.error ? <ErrorState error={html.error} /> : (
              // Sandboxed: the invoice HTML is server-rendered without escaping
              // (contract §2.5), so scripts are never allowed to run in it.
              <iframe ref={frame} title={`Invoice ${b.bill_number}`} sandbox="allow-same-origin allow-modals"
                srcDoc={srcdoc(html.data?.html || '')} className="h-[70vh] min-h-[560px] w-full bg-white" />
            )}
          </div>

          {b.tax_breakup?.rows?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-slate-500"><tr><th className="py-1.5">HSN/SAC</th><th>Rate</th><th className="text-right">Taxable</th><th className="text-right">CGST</th><th className="text-right">SGST</th></tr></thead>
                <tbody>{b.tax_breakup.rows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-100 dark:border-white/5"><td className="py-1.5">{r.hsn} <span className="text-slate-500">{r.description}</span></td><td>{r.rate}%</td>
                    <td className="num text-right">{money2(r.taxable)}</td><td className="num text-right">{money2(r.cgst)}</td><td className="num text-right">{money2(r.sgst)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={pdf.isPending} onClick={() => pdf.mutate(true)}>Regenerate PDF</Button>
          </div>
        </div>
      )}

      {b && dialog === 'guest' && <GuestDialog bill={b} onClose={() => setDialog(null)} onSaved={() => invalidate(b.id)} />}
      {b && dialog === 'gst' && <GstDialog bill={b} onClose={() => setDialog(null)} onSaved={() => invalidate(b.id)} />}
      {b && dialog === 'pay' && <PayDialog bill={b} onClose={() => setDialog(null)} onSaved={() => invalidate(b.id)} />}
      {b && dialog === 'cancel' && <CancelDialog bill={b} onClose={() => setDialog(null)} onSaved={() => invalidate(b.id)} />}
      {b && dialog === 'wa' && <WhatsAppDialog bill={b} onClose={() => setDialog(null)} onSent={() => invalidate(b.id)} />}
      {b && dialog === 'log' && <ActivityDialog billId={b.id} onClose={() => setDialog(null)} />}
    </Drawer>
  )
}

function Mini({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-white/5">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`num text-base font-semibold ${accent || ''}`}>{value}</div>
    </div>
  )
}

function useSave<T>(fn: (body: T) => Promise<unknown>, onSaved: () => void, onClose: () => void, okMsg: string) {
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => { toast(((r as { message?: string })?.message) || okMsg); onSaved(); onClose() },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'error'),
  })
}

function GuestDialog({ bill, onClose, onSaved }: { bill: Bill; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(bill.guest_name)
  const [mobile, setMobile] = useState(bill.guest_mobile || '')
  const m = useSave(() => patch(`/api/v2/bills/${bill.id}/guest`, { guest_name: name.trim(), guest_mobile: mobile }), onSaved, onClose, 'Guest details updated')
  return (
    <Modal open onClose={onClose} title="Correct guest details" size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!name.trim() || !/^(\d{10})?$/.test(mobile)} onClick={() => m.mutate(undefined)}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Guest name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></Field>
        <Field label="Mobile" hint="10 digits, or leave empty"><Input inputMode="numeric" value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} /></Field>
        <p className="text-xs text-slate-500">Amounts and taxes are not affected. The change is audit-logged and the PDF is refreshed.</p>
      </div>
    </Modal>
  )
}

function GstDialog({ bill, onClose, onSaved }: { bill: Bill; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ gstin: bill.recipient_gstin || '', legal: bill.recipient_legal_name || '', trade: bill.recipient_trade_name || '', address: bill.recipient_address || '' })
  const recips = useQuery({ queryKey: ['gst-recipients'], queryFn: () => get<{ recipients: { gstin: string; legal_name: string; trade_name?: string; address?: string }[] }>('/api/v2/gst/recipients').then((r) => r.recipients), staleTime: 300_000 })
  const save = useSave(() => patch(`/api/v2/bills/${bill.id}/gst`, { recipient_gstin: f.gstin.toUpperCase(), recipient_legal_name: f.legal, recipient_trade_name: f.trade, recipient_address: f.address }), onSaved, onClose, 'GST details saved')
  const clear = useSave(() => patch(`/api/v2/bills/${bill.id}/gst`, { clear: true }), onSaved, onClose, 'GST details cleared')
  const valid = /^[0-9A-Z]{15}$/i.test(f.gstin) && f.legal.trim().length > 0
  const locked = (bill.linked_credit_note_ids || []).length > 0
  return (
    <Modal open onClose={onClose} title="Bill to a company (B2B)"
      footer={<>{bill.invoice_type === 'B2B' && <Button variant="ghost" loading={clear.isPending} disabled={locked} onClick={() => clear.mutate(undefined)}>Make B2C</Button>}<div className="flex-1" />
        <Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!valid || locked} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="space-y-3">
        {locked && <Notice tone="amber">A credit note was issued against this invoice, so its GST details are locked.</Notice>}
        {!!recips.data?.length && (
          <Field label="Recent companies">
            <Select value="" onChange={(e) => { const r = recips.data!.find((x) => x.gstin === e.target.value); if (r) setF({ gstin: r.gstin, legal: r.legal_name, trade: r.trade_name || '', address: r.address || '' }) }}>
              <option value="">Pick a saved GSTIN…</option>
              {recips.data.map((r) => <option key={r.gstin} value={r.gstin}>{r.legal_name} · {r.gstin}</option>)}
            </Select>
          </Field>
        )}
        <Field label="GSTIN"><Input value={f.gstin} maxLength={15} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} className="num uppercase" /></Field>
        <Field label="Legal name"><Input value={f.legal} onChange={(e) => setF({ ...f, legal: e.target.value })} maxLength={200} /></Field>
        <Field label="Trade name"><Input value={f.trade} onChange={(e) => setF({ ...f, trade: e.target.value })} maxLength={200} /></Field>
        <Field label="Address"><Textarea value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={500} /></Field>
      </div>
    </Modal>
  )
}

function PayDialog({ bill, onClose, onSaved }: { bill: Bill; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ amount: String(bill.balance), mode: 'cash' as 'cash' | 'online', date: istDate(), discount: '', dtype: 'financial' as 'financial' | 'credit_note', reason: '', bad: false })
  const amount = Number(f.amount || 0)
  const disc = Number(f.discount || 0)
  const m = useSave(() => post(`/api/v2/bills/${bill.id}/payments`, {
    payment_mode: f.mode, payment_date: f.date, amount, discount: disc, discount_type: f.dtype, discount_reason: f.reason, bad_debt: f.bad,
  }), onSaved, onClose, 'Payment recorded')
  return (
    <Modal open onClose={onClose} title={`Collect on ${bill.bill_number}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="success" loading={m.isPending} disabled={amount + disc <= 0 || amount + disc > bill.balance} onClick={() => m.mutate(undefined)}>Record {money(amount)}</Button></>}>
      <div className="space-y-3">
        <div className="text-sm text-slate-500">Balance due <span className="num font-semibold text-rose-600">{money(bill.balance)}</span></div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount"><Input type="number" min={0} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Received on"><Input type="date" value={f.date} max={istDate()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        </div>
        <Segmented value={f.mode} onChange={(v) => setF({ ...f, mode: v })} className="w-full" options={[{ value: 'cash', label: 'Cash' }, { value: 'online', label: 'Online / UPI' }]} />
        <details className="rounded-xl border border-slate-200 px-3 py-2 dark:border-white/10">
          <summary className="cursor-pointer text-sm">Discount / write-off</summary>
          <div className="space-y-3 py-3">
            <Field label="Discount"><Input type="number" min={0} value={f.discount} onChange={(e) => setF({ ...f, discount: e.target.value })} /></Field>
            <Segmented value={f.dtype} onChange={(v) => setF({ ...f, dtype: v })} className="w-full" options={[{ value: 'financial', label: 'Financial discount' }, { value: 'credit_note', label: 'Credit note' }]} />
            <Field label="Reason"><Input value={f.reason} maxLength={300} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
            <Toggle checked={f.bad} onChange={(v) => setF({ ...f, bad: v })} label="Bad debt (cannot be recovered)" />
          </div>
        </details>
      </div>
    </Modal>
  )
}

interface Receipt { method: string; amount: number; date: string; time: string }

function CancelDialog({ bill, onClose, onSaved }: { bill: Bill; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState('')
  const [ack, setAck] = useState(false)
  const [receipts, setReceipts] = useState<null | { list: Receipt[]; canRemove: boolean; block?: string }>(null)
  const [remove, setRemove] = useState(false)
  const m = useMutation({
    mutationFn: () => post<{ message: string }>(`/api/v2/bills/${bill.id}/cancel`, { reason: reason.trim(), confirm: true, remove_receipts: remove }),
    onSuccess: (r) => { toast(r.message || 'Bill cancelled'); onSaved(); onClose() },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'HAS_RECEIPTS') {
        const body = e.body as { receipt_entries?: Receipt[]; can_remove_receipts?: boolean; remove_block_reason?: string }
        setReceipts({ list: body.receipt_entries || [], canRemove: !!body.can_remove_receipts, block: body.remove_block_reason })
      } else toast(e instanceof Error ? e.message : 'Cancel failed', 'error')
    },
  })
  return (
    <Modal open onClose={onClose} title={`Cancel ${bill.bill_number}?`}
      footer={<><Button variant="secondary" onClick={onClose}>Keep bill</Button><Button variant="danger" loading={m.isPending} disabled={reason.trim().length < 10 || !ack || (!!receipts && !remove)} onClick={() => m.mutate()}>Cancel bill</Button></>}>
      <div className="space-y-3">
        <Notice tone="amber">The invoice number is kept and reported as cancelled in GSTR-1. Use this for mistakes such as a duplicate room entry. Months that are GST-locked need a credit note instead.</Notice>
        <Field label="Reason (10–500 characters)"><Textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4 accent-rose-600" checked={ack} onChange={(e) => setAck(e.target.checked)} />I understand this cannot be undone.</label>
        {receipts && (
          <div className="space-y-2">
            <Notice tone="red">Money was recorded against this stay:</Notice>
            <ul className="text-sm">{receipts.list.map((r, i) => <li key={i} className="num">{money(r.amount)} {r.method} · {stamp(`${r.date} ${r.time}`)}</li>)}</ul>
            {receipts.canRemove
              ? <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4 accent-rose-600" checked={remove} onChange={(e) => setRemove(e.target.checked)} />No money was actually received — remove these entries too.</label>
              : <p className="text-sm text-slate-500">{receipts.block || 'These receipts cannot be removed here.'}</p>}
          </div>
        )}
      </div>
    </Modal>
  )
}

function WhatsAppDialog({ bill, onClose, onSent }: { bill: Bill; onClose: () => void; onSent: () => void }) {
  const [to, setTo] = useState(bill.guest_mobile || '')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    setBusy(true)
    try {
      const r = await post<{ pdf_url: string }>(`/api/v2/bills/${bill.id}/pdf`, { force: false })
      // Same message text as the old Bills tab (static/bills.js).
      const msg = `Hi ${bill.guest_name}, your invoice #${bill.bill_number} for ₹${bill.total_amount} from Cibara Comforts is ready.\n\nView / Download: ${r.pdf_url}\n\nThank you for staying with us!`
      window.open(`https://wa.me/91${to}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener')
      await post(`/api/v2/bills/${bill.id}/activity`, { kind: 'whatsapp', to }).catch(() => {})
      onSent()
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not prepare the PDF', 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open onClose={onClose} title="Send on WhatsApp" size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!/^\d{10}$/.test(to)} onClick={send}>Open WhatsApp</Button></>}>
      <Field label="Mobile" hint="The PDF link is sent from your WhatsApp."><Input inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, '').slice(0, 10))} /></Field>
    </Modal>
  )
}

function ActivityDialog({ billId, onClose }: { billId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['bill-audit', billId], queryFn: () => get<{ entries: { action: string; userName: string; userId: string; timestamp: string }[] }>(`/api/v2/bills/${billId}/audit`).then((r) => r.entries) })
  return (
    <Modal open onClose={onClose} title="Activity" size="sm">
      {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.length ? <p className="text-sm text-slate-500">No recorded activity.</p> : (
        <ol className="space-y-3">{q.data.map((e, i) => (
          <li key={i} className="text-sm"><div className="font-medium">{e.action}</div><div className="text-xs text-slate-500">{e.userName || e.userId} · {stamp(e.timestamp)}</div></li>
        ))}</ol>
      )}
    </Modal>
  )
}

import { useMutation, useQuery } from '@tanstack/react-query'
import { FileDown, FileMinus } from 'lucide-react'
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { get, post } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { money, shortDate } from '@/lib/format'
import { toast } from '@/lib/ui'

interface CN {
  cn_id: string; cn_number: string; cn_date: string; against_bill_number: string; against_invoice_date: string
  recipient_gstin?: string; recipient_legal_name?: string; reason: string; reason_text?: string
  credit_amount_total: number; gst_rate?: number; pdf_url?: string
}

const REASON: Record<string, string> = {
  checkout_mistake: 'Checkout mistake', post_supply_discount: 'Post-supply discount',
  service_deficiency: 'Service deficiency', cancellation: 'Cancellation', other: 'Other',
}

export function CreditNotes({ start, end }: { start: string; end: string }) {
  const canPdf = useCan('credit_note.issue')
  const q = useQuery({
    queryKey: ['credit-notes', start, end],
    queryFn: () => get<{ credit_notes: CN[] }>('/api/v2/credit-notes', { start, end }).then((r) => r.credit_notes),
  })
  const pdf = useMutation({
    mutationFn: (id: string) => post<{ pdf_url: string }>(`/api/v2/credit-notes/${id}/pdf`, { force: false }),
    onSuccess: (r) => { window.open(r.pdf_url, '_blank', 'noopener'); void q.refetch() },
    onError: (e) => toast(e instanceof Error ? e.message : 'PDF failed', 'error'),
  })
  const total = (q.data || []).reduce((s, c) => s + (c.credit_amount_total || 0), 0)
  return (
    <Card className="mt-4" padded={false} title={q.data ? `${q.data.length} credit notes · ${money(total)}` : 'Credit notes'}>
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.isLoading ? <div className="p-4"><Skeleton className="h-32" /></div>
        : !q.data?.length ? <EmptyState title="No credit notes in this range" icon={<FileMinus className="size-6" />} /> : (
          <ul className="divide-y divide-slate-100 dark:divide-white/5">
            {q.data.map((c) => (
              <li key={c.cn_id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <div className="num font-medium">{c.cn_number} <span className="text-xs text-slate-500">· {shortDate(c.cn_date)}</span></div>
                  <div className="text-xs text-slate-500">Against {c.against_bill_number} ({shortDate(c.against_invoice_date)}) · {c.recipient_gstin ? `${c.recipient_legal_name} · ${c.recipient_gstin}` : 'Unregistered (B2C)'}</div>
                  <div className="mt-1"><Badge tone="amber">{REASON[c.reason] || c.reason}</Badge> {c.reason_text && <span className="text-xs text-slate-500">{c.reason_text}</span>}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="num font-semibold text-rose-600">−{money(c.credit_amount_total)}</span>
                  {c.pdf_url ? <a href={c.pdf_url} target="_blank" rel="noopener" className="text-sm font-medium text-brand-600 hover:underline">View PDF</a>
                    : canPdf && <Button size="sm" variant="secondary" icon={<FileDown className="size-3.5" />} loading={pdf.isPending && pdf.variables === c.cn_id} onClick={() => pdf.mutate(c.cn_id)}>Generate</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
    </Card>
  )
}

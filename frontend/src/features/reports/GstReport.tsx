import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, ErrorState, Input, Skeleton, StatCard } from '@/components/ui'
import { get } from '@/lib/api'
import { istDate, money2 } from '@/lib/format'

interface Row {
  bill_number: string; invoice_date: string; recipient_gstin: string; recipient_name: string; place_of_supply: string
  gst_rate: number; taxable: number; cgst: number; sgst: number; igst: number; invoice_value: number; status: string
}
interface Gstr1 {
  b2b: Row[]; b2cl: Row[]
  b2cs: { gst_rate: number; place_of_supply: string; taxable: number; cgst: number; sgst: number; igst: number; invoice_value: number; count: number }[]
  cancelled_documents: Row[]
  documents: { listed: number; cancelled: number; net_live: number }
  rate_summary: Record<string, { taxable: number; cgst: number; sgst: number; igst: number }>
  hsn_summary: { hsn: string; gst_rate: number; taxable: number; cgst: number; sgst: number; igst: number }[]
  ota_commission_itc: number; ota_commission_count: number
  totals: { taxable: number; cgst: number; sgst: number; igst: number; invoice_value: number; invoices: number }
}

function csv(name: string, head: string[], rows: (string | number)[][]) {
  const text = [head, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  if (!rows.length) return <p className="py-4 text-sm text-slate-500">None.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-500"><tr>{head.map((h, j) => <th key={h} className={`px-2 py-2 font-medium ${typeof rows[0][j] === 'number' ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-white/5">{rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => <td key={j} className={`px-2 py-2 ${typeof c === 'number' ? 'num text-right' : ''}`}>{typeof c === 'number' ? money2(c) : c}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  )
}

export function GstReport() {
  const [month, setMonth] = useState(istDate().slice(0, 7))
  const q = useQuery({ queryKey: ['gstr1', month], queryFn: () => get<Gstr1>('/api/v2/reports/gstr1', { month }) })
  const d = q.data
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="month" aria-label="Month" value={month} max={istDate().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} className="w-auto" />
        <p className="text-xs text-slate-500">Figures come from each bill's stored per-night folio — the same numbers printed on the invoices.</p>
      </div>
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <Skeleton className="h-96" /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatCard label="Taxable value" value={money2(d.totals.taxable)} tone="brand" />
            <StatCard label="CGST" value={money2(d.totals.cgst)} tone="cyan" />
            <StatCard label="SGST" value={money2(d.totals.sgst)} tone="cyan" />
            <StatCard label="Invoices" value={d.documents.net_live} hint={`${d.documents.listed} issued · ${d.documents.cancelled} cancelled`} tone="slate" />
            <StatCard label="OTA commission ITC" value={money2(d.ota_commission_itc)} hint={`${d.ota_commission_count} invoices`} tone="violet" />
          </div>
          <Card title="Rate-wise summary">
            <Table head={['Rate', 'Taxable', 'CGST', 'SGST', 'IGST']} rows={Object.entries(d.rate_summary).map(([r, v]) => [`${r}%`, v.taxable, v.cgst, v.sgst, v.igst])} />
          </Card>
          <Card title={`B2B invoices (${d.b2b.length})`} action={d.b2b.length > 0 && <Button size="sm" variant="secondary" icon={<Download className="size-3.5" />}
            onClick={() => csv(`gstr1_b2b_${month}.csv`, ['GSTIN', 'Name', 'Invoice', 'Date', 'Value', 'Place of supply', 'Rate', 'Taxable', 'CGST', 'SGST'],
              d.b2b.map((r) => [r.recipient_gstin, r.recipient_name, r.bill_number, r.invoice_date, r.invoice_value, r.place_of_supply, r.gst_rate, r.taxable, r.cgst, r.sgst]))}>CSV</Button>}>
            <Table head={['Invoice', 'Date', 'GSTIN', 'Name', 'Rate', 'Taxable', 'CGST', 'SGST', 'Value']}
              rows={d.b2b.map((r) => [r.bill_number, r.invoice_date, r.recipient_gstin, r.recipient_name, `${r.gst_rate}%`, r.taxable, r.cgst, r.sgst, r.invoice_value])} />
          </Card>
          <Card title="B2C (small) — by rate & place of supply" action={<Button size="sm" variant="secondary" icon={<Download className="size-3.5" />}
            onClick={() => csv(`gstr1_b2cs_${month}.csv`, ['Place of supply', 'Rate', 'Taxable', 'CGST', 'SGST', 'Invoices'],
              d.b2cs.map((r) => [r.place_of_supply, r.gst_rate, r.taxable, r.cgst, r.sgst, r.count]))}>CSV</Button>}>
            <Table head={['Place of supply', 'Rate', 'Taxable', 'CGST', 'SGST', 'Value']} rows={d.b2cs.map((r) => [r.place_of_supply, `${r.gst_rate}%`, r.taxable, r.cgst, r.sgst, r.invoice_value])} />
          </Card>
          <Card title="HSN / SAC summary" action={<Button size="sm" variant="secondary" icon={<Download className="size-3.5" />}
            onClick={() => csv(`gstr1_hsn_${month}.csv`, ['HSN/SAC', 'Rate', 'Taxable', 'CGST', 'SGST', 'IGST'], d.hsn_summary.map((r) => [r.hsn, r.gst_rate, r.taxable, r.cgst, r.sgst, r.igst]))}>CSV</Button>}>
            <Table head={['HSN/SAC', 'Rate', 'Taxable', 'CGST', 'SGST', 'IGST']} rows={d.hsn_summary.map((r) => [r.hsn, `${r.gst_rate}%`, r.taxable, r.cgst, r.sgst, r.igst])} />
          </Card>
          {d.cancelled_documents.length > 0 && (
            <Card title={`Cancelled documents (${d.cancelled_documents.length})`}>
              <Table head={['Invoice', 'Date', 'Name']} rows={d.cancelled_documents.map((r) => [r.bill_number, r.invoice_date, r.recipient_name || '—'])} />
            </Card>
          )}
          <p className="text-xs text-slate-500">Credit notes are listed under Bills → Credit notes. The full GSTR-1 / 3B Excel workbook is still produced from the classic Bills screen.</p>
        </>
      )}
    </div>
  )
}

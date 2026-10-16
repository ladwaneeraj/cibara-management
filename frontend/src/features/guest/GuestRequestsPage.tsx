import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, Check, Eye, Printer, QrCode, Settings2, Star } from 'lucide-react'
import { useState } from 'react'
import { PageHeader } from '@/components/layout/AppShell'
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, Segmented, Skeleton, StatCard, Tabs, Textarea, Toggle } from '@/components/ui'
import { api, get, patch, post } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { duration, stamp } from '@/lib/format'
import { toast } from '@/lib/ui'
import { useRealtimeLive } from '@/features/dashboard/hooks'

interface Req {
  id: string; room: string; guestName: string; kind: string; team: string; note?: string; status: string
  createdAtMs: number; acknowledgedBy?: string; doneBy?: string; responseSec?: number | null; completionSec?: number | null
}
interface Settings {
  enabled: boolean; hotelName: string; receptionPhone: string; whatsapp: string; wifiName: string; wifiPassword?: string
  checkoutTime: string; sessionHours: number; houseRules: string; nearbyInfo: string; publicBaseUrl: string
  kinds: Record<string, boolean>; kindMeta: Record<string, { label: string; team: string }>; portalUrl: string
}

const ago = (ms: number) => duration((Date.now() - ms) / 60000)

export function GuestRequestsPage() {
  const canManage = useCan('guest_portal.manage')
  const [tab, setTab] = useState<'live' | 'history'>('live')
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <div>
      <PageHeader title="Guest requests" subtitle="Room-service requests from the QR guest portal"
        actions={canManage && <Button variant="secondary" size="sm" icon={<Settings2 className="size-4" />} onClick={() => setSettingsOpen(true)}>Portal settings</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'live', label: 'Open' }, { value: 'history', label: 'History' }]} />
      <div className="mt-4">{tab === 'live' ? <Live /> : <History />}</div>
      {settingsOpen && <PortalSettings onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

function Live() {
  const live = useRealtimeLive()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['guest-requests'],
    queryFn: () => get<{ requests: Req[] }>('/api/v2/guest-requests').then((r) => r.requests),
    refetchInterval: live ? 120_000 : 15_000,
  })
  const move = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'acknowledge' | 'done' }) => post(`/api/v2/guest-requests/${id}/${action}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['guest-requests'] }),
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'error'),
  })
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  if (!q.data) return <Skeleton className="h-48" />
  if (!q.data.length) return <EmptyState title="All caught up" hint="New requests appear here instantly." icon={<BellRing className="size-6" />} />
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {q.data.map((r) => (
        <Card key={r.id} className={r.status === 'open' ? 'ring-2 ring-amber-400/60' : ''}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-lg font-semibold">Room {r.room}</div>
              <div className="text-sm text-slate-500">{r.guestName || 'Guest'} · {ago(r.createdAtMs)} ago</div>
            </div>
            <Badge tone={r.status === 'open' ? 'amber' : 'blue'}>{r.status === 'open' ? 'New' : 'Seen'}</Badge>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Badge tone={r.team === 'housekeeping' ? 'cyan' : 'brand'}>{r.team === 'housekeeping' ? 'Housekeeping' : 'Desk'}</Badge>
            <span className="font-medium capitalize">{r.kind.replace(/_/g, ' ')}</span>
          </div>
          {r.note && <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-sm dark:bg-white/5">{r.note}</p>}
          <div className="mt-4 flex gap-2">
            {r.status === 'open' && <Button size="sm" variant="secondary" icon={<Eye className="size-4" />} loading={move.isPending} onClick={() => move.mutate({ id: r.id, action: 'acknowledge' })}>Seen</Button>}
            <Button size="sm" variant="success" icon={<Check className="size-4" />} loading={move.isPending} onClick={() => move.mutate({ id: r.id, action: 'done' })}>Done</Button>
          </div>
        </Card>
      ))}
    </div>
  )
}

function History() {
  const [days, setDays] = useState<'1' | '7' | '30' | '90'>('7')
  const q = useQuery({
    queryKey: ['guest-history', days],
    queryFn: () => get<{ requests: Req[]; feedback: { room: string; rating: number; comment?: string; guestName?: string; createdAtMs: number }[]; summary: { total: number; done: number; cancelled: number; avgResponseSec: number | null; avgCompletionSec: number | null; avgRating: number | null } }>('/api/v2/guest-requests/history', { days }),
  })
  const s = q.data?.summary
  return (
    <div className="space-y-4">
      <Segmented value={days} onChange={setDays} size="sm" options={[{ value: '1', label: 'Today' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
      {q.error ? <ErrorState error={q.error} /> : !q.data ? <Skeleton className="h-64" /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Requests" value={s!.total} hint={`${s!.done} done · ${s!.cancelled} cancelled`} tone="brand" />
            <StatCard label="Avg first response" value={s!.avgResponseSec != null ? duration(s!.avgResponseSec / 60) : '—'} tone="amber" />
            <StatCard label="Avg completion" value={s!.avgCompletionSec != null ? duration(s!.avgCompletionSec / 60) : '—'} tone="cyan" />
            <StatCard label="Guest rating" value={s!.avgRating != null ? `${s!.avgRating.toFixed(1)} ★` : '—'} hint={`${q.data.feedback.length} ratings`} tone="green" />
          </div>
          <Card padded={false} title="Requests">
            {q.data.requests.length === 0 ? <EmptyState title="No requests in this period" /> : (
              <ul className="divide-y divide-slate-100 dark:divide-white/5">{q.data.requests.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                  <div className="min-w-0"><div className="font-medium capitalize">Room {r.room} · {r.kind.replace(/_/g, ' ')}</div><div className="truncate text-xs text-slate-500">{stamp(new Date(r.createdAtMs + 330 * 60000).toISOString().slice(0, 16).replace('T', ' '))}{r.note ? ` · ${r.note}` : ''}</div></div>
                  <div className="flex items-center gap-2 text-xs text-slate-500">{r.completionSec != null && <span className="num">{duration(r.completionSec / 60)}</span>}<Badge tone={r.status === 'done' ? 'green' : r.status === 'cancelled' ? 'slate' : 'amber'}>{r.status}</Badge></div>
                </li>
              ))}</ul>
            )}
          </Card>
          {q.data.feedback.length > 0 && (
            <Card title="Guest feedback">
              <ul className="space-y-2">{q.data.feedback.map((f, i) => (
                <li key={i} className="text-sm"><span className="font-medium">Room {f.room}</span> <span className="text-amber-500">{'★'.repeat(f.rating)}</span>{f.comment && <span className="text-slate-600 dark:text-slate-300"> — {f.comment}</span>}</li>
              ))}</ul>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function PortalSettings({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['portal-settings'], queryFn: () => get<{ settings: Settings }>('/api/v2/guest-portal/settings').then((r) => r.settings) })
  const [draft, setDraft] = useState<Partial<Settings> | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const s = { ...(q.data || {}), ...(draft || {}) } as Settings
  const save = useMutation({
    mutationFn: () => patch('/api/v2/guest-portal/settings', {
      enabled: s.enabled, hotelName: s.hotelName, receptionPhone: s.receptionPhone, whatsapp: s.whatsapp, wifiName: s.wifiName,
      wifiPassword: s.wifiPassword ?? '', checkoutTime: s.checkoutTime, sessionHours: Number(s.sessionHours), houseRules: s.houseRules,
      nearbyInfo: s.nearbyInfo, publicBaseUrl: s.publicBaseUrl, kinds: s.kinds,
    }),
    onSuccess: () => { toast('Portal settings saved'); void qc.invalidateQueries({ queryKey: ['portal-settings'] }); onClose() },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'error'),
  })
  const loadQr = async () => {
    const res = await api<Response>('/api/v2/guest-portal/qr.png', { raw: true })
    setQr(URL.createObjectURL(await res.blob()))
  }
  const set = (k: keyof Settings, v: unknown) => setDraft({ ...(draft || {}), [k]: v })
  return (
    <Modal open onClose={onClose} title="Guest portal" size="lg"
      footer={<><Button variant="secondary" icon={<QrCode className="size-4" />} onClick={loadQr}>Show QR</Button><div className="flex-1" /><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={save.isPending} disabled={!draft} onClick={() => save.mutate()}>Save</Button></>}>
      {!q.data ? <Skeleton className="h-64" /> : (
        <div className="space-y-4">
          <Toggle checked={!!s.enabled} onChange={(v) => set('enabled', v)} label="Portal switched on" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Hotel name"><Input value={s.hotelName || ''} onChange={(e) => set('hotelName', e.target.value)} maxLength={120} /></Field>
            <Field label="Reception phone"><Input value={s.receptionPhone || ''} onChange={(e) => set('receptionPhone', e.target.value)} maxLength={120} /></Field>
            <Field label="WhatsApp"><Input value={s.whatsapp || ''} onChange={(e) => set('whatsapp', e.target.value)} maxLength={120} /></Field>
            <Field label="Checkout time"><Input value={s.checkoutTime || ''} onChange={(e) => set('checkoutTime', e.target.value)} maxLength={120} /></Field>
            <Field label="Wi-Fi name"><Input value={s.wifiName || ''} onChange={(e) => set('wifiName', e.target.value)} maxLength={120} /></Field>
            <Field label="Wi-Fi password"><Input value={s.wifiPassword || ''} onChange={(e) => set('wifiPassword', e.target.value)} maxLength={120} /></Field>
            <Field label="Session length (hours)" hint="1–72. Keep at 24 or more: the guest app requests a 24-hour session."><Input type="number" min={1} max={72} value={s.sessionHours ?? 24} onChange={(e) => set('sessionHours', e.target.value)} /></Field>
            <Field label="Public portal URL" hint={`Currently ${s.portalUrl}`}><Input value={s.publicBaseUrl || ''} placeholder="https://…" onChange={(e) => set('publicBaseUrl', e.target.value)} maxLength={120} /></Field>
          </div>
          <Field label="House rules"><Textarea value={s.houseRules || ''} onChange={(e) => set('houseRules', e.target.value)} maxLength={2000} /></Field>
          <Field label="Nearby info"><Textarea value={s.nearbyInfo || ''} onChange={(e) => set('nearbyInfo', e.target.value)} maxLength={2000} /></Field>
          <div>
            <span className="label">Request types offered</span>
            <div className="grid gap-x-6 sm:grid-cols-2">
              {Object.entries(s.kindMeta || {}).map(([k, meta]) => (
                <Toggle key={k} checked={s.kinds?.[k] !== false} onChange={(v) => set('kinds', { ...(s.kinds || {}), [k]: v })} label={meta.label} />
              ))}
            </div>
          </div>
          {qr && (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-slate-200 p-4 dark:border-white/10">
              <img src={qr} alt="Guest portal QR" className="size-56" />
              <p className="text-sm text-slate-500">Scan to request room service · {s.portalUrl}</p>
              <Button size="sm" variant="secondary" icon={<Printer className="size-4" />} onClick={() => {
                const w = window.open('', '_blank', 'width=600,height=700')
                if (!w) return
                w.document.write(`<title>Room QR</title><div style="font-family:sans-serif;text-align:center;padding:40px"><h2>${(s.hotelName || '').replace(/</g, '&lt;')}</h2><img src="${qr}" style="width:320px"><p>Scan for room service, Wi-Fi and reception</p></div>`)
                w.document.close(); w.focus(); w.print()
              }}>Print</Button>
            </div>
          )}
          <p className="flex items-center gap-1.5 text-xs text-slate-500"><Star className="size-3.5" />Guests sign in on their phone with the room number and the mobile given at check-in.</p>
        </div>
      )}
    </Modal>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, KeyRound, LogOut, Plus, Power, Search, ShieldCheck, UserCog } from 'lucide-react'
import { useState } from 'react'
import { PageHeader } from '@/components/layout/AppShell'
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, Select, Skeleton, Tabs, Toggle } from '@/components/ui'
import { del, get, patch, post } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { addDays, istDate, stamp } from '@/lib/format'
import { confirmDialog, toast } from '@/lib/ui'

type Tab = 'users' | 'audit' | 'settings' | 'health'
interface U { userId: string; name: string; role: 'admin' | 'manager' | 'housekeeping'; isActive: boolean; lastLoginAt?: string | null; createdAt?: string }
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', housekeeping: 'Staff' }

export function AdminPage() {
  const can = useAuth((s) => s.can)
  useAuth((s) => s.permissions)
  const tabs: { value: Tab; label: string; hidden?: boolean }[] = [
    { value: 'users', label: 'Users', hidden: !can('user.manage') },
    { value: 'audit', label: 'Audit log', hidden: !can('logs.view') },
    { value: 'settings', label: 'Settings', hidden: !can('settings.update') },
    { value: 'health', label: 'System health', hidden: !can('logs.view') },
  ]
  const [tab, setTab] = useState<Tab>(tabs.find((t) => !t.hidden)?.value ?? 'users')
  return (
    <div>
      <PageHeader title="Admin" subtitle="Users, audit trail, settings and system health" />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      <div className="mt-4">
        {tab === 'users' && <Users />}
        {tab === 'audit' && <Audit />}
        {tab === 'settings' && <Settings />}
        {tab === 'health' && <Health />}
      </div>
    </div>
  )
}

function useAct() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { toast('Saved'); void qc.invalidateQueries({ queryKey: ['users'] }) },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'error'),
  })
}

function Users() {
  const me = useAuth((s) => s.user?.userId)
  const q = useQuery({ queryKey: ['users'], queryFn: () => get<{ users: U[] }>('/api/v2/admin/users').then((r) => r.users) })
  const act = useAct()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<U | null>(null)
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const days = (ts?: string | null) => (ts ? Math.floor((Date.now() - Date.parse(ts.replace(' ', 'T') + '+05:30')) / 86400000) : null)
  return (
    <Card padded={false} title={`${q.data?.filter((u) => u.isActive).length ?? 0} active users`} action={<Button size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New user</Button>}>
      {!q.data ? <div className="p-4"><Skeleton className="h-40" /></div> : (
        <ul className="divide-y divide-slate-100 dark:divide-white/5">{q.data.map((u) => {
          const d = days(u.lastLoginAt)
          return (
            <li key={u.userId} className={`flex flex-wrap items-center justify-between gap-3 px-5 py-3 ${u.isActive ? '' : 'opacity-55'}`}>
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium">{u.name} <span className="text-sm font-normal text-slate-500">@{u.userId}</span>{u.userId === me && <Badge tone="brand">you</Badge>}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  <Badge tone={u.role === 'admin' ? 'violet' : u.role === 'manager' ? 'brand' : 'cyan'}>{ROLE_LABEL[u.role]}</Badge>
                  {!u.isActive && <Badge tone="red">Deactivated</Badge>}
                  <span>{u.lastLoginAt ? `Last seen ${stamp(u.lastLoginAt)}` : 'Never signed in'}</span>
                  {d != null && d >= 30 && <Badge tone="amber">{d >= 60 ? 'Dormant' : 'Stale'}</Badge>}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="ghost" icon={<UserCog className="size-4" />} onClick={() => setEditing(u)}>Edit</Button>
                <Button size="sm" variant="ghost" icon={<KeyRound className="size-4" />} onClick={async () => {
                  const pw = window.prompt(`New password for ${u.userId} (min 6 characters)`)
                  if (pw && pw.length >= 6) act.mutate(() => post(`/api/v2/admin/users/${u.userId}/reset-password`, { password: pw }))
                }}>Reset password</Button>
                <Button size="sm" variant="ghost" icon={<LogOut className="size-4" />} onClick={async () => {
                  if (await confirmDialog({ title: `Sign ${u.name} out everywhere?`, message: 'Their open sessions end immediately.', confirmLabel: 'Force logout' }))
                    act.mutate(() => post(`/api/v2/admin/users/${u.userId}/force-logout`))
                }}>Force logout</Button>
                {u.isActive
                  ? <Button size="sm" variant="ghost" icon={<Power className="size-4 text-rose-500" />} onClick={async () => {
                    if (await confirmDialog({ title: `Deactivate ${u.name}?`, message: 'They can no longer sign in. You can reactivate them later.', confirmLabel: 'Deactivate', danger: true }))
                      act.mutate(() => del(`/api/v2/admin/users/${u.userId}`))
                  }}>Deactivate</Button>
                  : <Button size="sm" variant="ghost" icon={<Power className="size-4 text-emerald-500" />} onClick={() => act.mutate(() => patch(`/api/v2/admin/users/${u.userId}`, { isActive: true }))}>Reactivate</Button>}
              </div>
            </li>
          )
        })}</ul>
      )}
      {creating && <CreateUser onClose={() => setCreating(false)} />}
      {editing && <EditUser u={editing} onClose={() => setEditing(null)} />}
    </Card>
  )
}

function CreateUser({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ userId: '', name: '', role: 'manager', password: '' })
  const m = useMutation({
    mutationFn: () => post('/api/v2/admin/users', { ...f, userId: f.userId.trim().toLowerCase() }),
    onSuccess: () => { toast(`User ${f.userId} created`); void qc.invalidateQueries({ queryKey: ['users'] }); onClose() },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'error'),
  })
  const valid = /^[a-z0-9][a-z0-9._-]{1,30}$/.test(f.userId.trim().toLowerCase()) && f.password.length >= 6
  return (
    <Modal open onClose={onClose} title="New user" size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!valid} onClick={() => m.mutate()}>Create</Button></>}>
      <div className="space-y-3">
        <Field label="User ID" hint="2–31 characters: lowercase letters, digits, . _ -"><Input autoCapitalize="none" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} /></Field>
        <Field label="Display name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} /></Field>
        <Field label="Role">
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="manager">Manager</option><option value="housekeeping">Staff (housekeeping)</option><option value="admin">Admin</option>
          </Select>
        </Field>
        <Field label="Initial password" hint="At least 6 characters"><Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      </div>
    </Modal>
  )
}

function EditUser({ u, onClose }: { u: U; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState(u.name)
  const [role, setRole] = useState(u.role)
  const m = useMutation({
    mutationFn: () => patch(`/api/v2/admin/users/${u.userId}`, { ...(name !== u.name ? { name } : {}), ...(role !== u.role ? { role } : {}) }),
    onSuccess: () => { toast('User updated'); void qc.invalidateQueries({ queryKey: ['users'] }); onClose() },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'error'),
  })
  return (
    <Modal open onClose={onClose} title={`Edit ${u.userId}`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!name.trim() || (name === u.name && role === u.role)} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Display name"><Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Role" hint={role !== u.role ? 'Changing the role signs them out so the new permissions apply.' : undefined}>
          <Select value={role} onChange={(e) => setRole(e.target.value as U['role'])}>
            <option value="manager">Manager</option><option value="housekeeping">Staff (housekeeping)</option><option value="admin">Admin</option>
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

interface Entry { id: string; timestamp: string; userId: string; userName: string; userRole: string; action: string; targetCollection?: string; targetId?: string; before?: unknown; after?: unknown; metadata?: Record<string, unknown>; ipAddress?: string }

function Audit() {
  const [f, setF] = useState({ start: istDate(), end: istDate(), userId: '', action: '', q: '' })
  const [open, setOpen] = useState<Entry | null>(null)
  const query = useQuery({
    queryKey: ['audit', f],
    queryFn: () => get<{ entries: Entry[] }>('/api/v2/admin/audit-logs', { ...f, limit: 300 }).then((r) => r.entries),
  })
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input type="date" aria-label="From" value={f.start} max={f.end} onChange={(e) => setF({ ...f, start: e.target.value })} className="w-auto" />
        <Input type="date" aria-label="To" value={f.end} min={f.start} max={istDate()} onChange={(e) => setF({ ...f, end: e.target.value })} className="w-auto" />
        <Input aria-label="User" placeholder="User ID" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value.toLowerCase() })} className="w-36" />
        <Input aria-label="Action" placeholder="Action e.g. room.checkout" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} className="w-52" />
        <div className="relative min-w-40 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input aria-label="Search" placeholder="Search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} className="pl-9" /></div>
        <Button variant="ghost" size="sm" onClick={() => setF({ ...f, start: addDays(istDate(), -6) })}>Last 7 days</Button>
      </div>
      <Card padded={false}>
        {query.error ? <ErrorState error={query.error} /> : !query.data ? <div className="p-4"><Skeleton className="h-64" /></div> : query.data.length === 0 ? <EmptyState title="No entries" icon={<ShieldCheck className="size-6" />} /> : (
          <ul className="divide-y divide-slate-100 dark:divide-white/5">{query.data.map((e) => (
            <li key={e.id}>
              <button type="button" onClick={() => setOpen(e)} className="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-white/[0.03]">
                <div className="min-w-0"><div className="truncate text-sm font-medium">{e.action}</div>
                  <div className="truncate text-xs text-slate-500">{e.userName || e.userId} ({e.userRole}){e.targetCollection ? ` · ${e.targetCollection}/${e.targetId ?? ''}` : ''}</div></div>
                <span className="shrink-0 text-xs text-slate-500">{stamp(e.timestamp)}</span>
              </button>
            </li>
          ))}</ul>
        )}
      </Card>
      <p className="text-xs text-slate-500">Without a user or action filter the server scans a bounded window of recent entries (legacy behaviour) — filter to be exhaustive.</p>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open?.action ?? ''} size="lg">
        {open && <pre className="max-h-[60vh] overflow-auto rounded-xl bg-slate-50 p-3 text-xs dark:bg-white/5">{JSON.stringify(open, null, 2)}</pre>}
      </Modal>
    </div>
  )
}

function Settings() {
  const qc = useQueryClient()
  const ui = useQuery({ queryKey: ['ui-config'], queryFn: () => get<{ config: Record<string, boolean> }>('/api/v2/settings/ui').then((r) => r.config) })
  const billing = useQuery({ queryKey: ['billing-config'], queryFn: () => get<{ config: Record<string, boolean> }>('/api/v2/settings/billing').then((r) => r.config) })
  const save = useMutation({
    mutationFn: ({ kind, body }: { kind: 'ui' | 'billing'; body: Record<string, boolean> }) => patch(`/api/v2/settings/${kind}`, body),
    onSuccess: () => { toast('Setting saved'); void qc.invalidateQueries({ queryKey: ['ui-config'] }); void qc.invalidateQueries({ queryKey: ['billing-config'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }) },
    onError: (e) => toast(e instanceof Error ? e.message : 'Failed', 'error'),
  })
  const u = ui.data || {}
  const b = billing.data || {}
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Billing">
        {!billing.data ? <Skeleton className="h-16" /> : (
          <Toggle checked={!!b.always_generate_bill} disabled={save.isPending} onChange={(v) => save.mutate({ kind: 'billing', body: { always_generate_bill: v } })}
            label="Always issue a numbered GST invoice (also for all-cash stays)" />
        )}
      </Card>
      <Card title="Front desk">
        {!ui.data ? <Skeleton className="h-32" /> : (
          <div className="space-y-1">
            <Toggle checked={!!u.inspection_photos} onChange={(v) => save.mutate({ kind: 'ui', body: { inspection_photos: v } })} label="Managers must photograph rooms 200–228 before release" />
            <Toggle checked={!!u.cleaning_photos} onChange={(v) => save.mutate({ kind: 'ui', body: { cleaning_photos: v } })} label="Housekeeping must photograph rooms 200–228 when cleaned" />
            <Toggle checked={!!u.hide_register_tab} onChange={(v) => save.mutate({ kind: 'ui', body: { hide_register_tab: v } })} label="Hide the Register tab (classic screens)" />
            <Toggle checked={!!u.incognito_mode} onChange={(v) => save.mutate({ kind: 'ui', body: { incognito_mode: v } })} label="Incognito mode (forces invoices, hides transactions)" />
          </div>
        )}
      </Card>
    </div>
  )
}

interface RouteStat { route: string; count: number; errors: number; avg_ms: number; p95_ms: number; reads: number; writes: number; reads_per_call: number }
interface Alert { id: string; kind: string; severity: string; message: string; created_at: string; resolved: boolean }

function Health() {
  const qc = useQueryClient()
  const m = useQuery({ queryKey: ['metrics'], queryFn: () => get<{ uptime_s: number; routes: RouteStat[]; totals: { requests: number; reads: number; writes: number } }>('/api/v2/admin/metrics'), refetchInterval: 30_000 })
  const a = useQuery({ queryKey: ['alerts'], queryFn: () => get<{ alerts: Alert[] }>('/api/v2/admin/alerts').then((r) => r.alerts) })
  const resolve = useMutation({
    mutationFn: (id: string) => post('/api/v2/admin/alerts/resolve', { alert_id: id }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alerts'] }),
  })
  return (
    <div className="space-y-4">
      <Card title="Open system alerts">
        {!a.data ? <Skeleton className="h-16" /> : a.data.length === 0 ? <p className="text-sm text-slate-500">No open alerts.</p> : (
          <ul className="space-y-2">{a.data.map((x) => (
            <li key={x.id} className="flex items-start justify-between gap-3 rounded-xl bg-rose-50 px-3 py-2 text-sm dark:bg-rose-500/10">
              <div><div className="font-medium">{x.kind} <Badge tone={x.severity === 'critical' ? 'red' : 'amber'}>{x.severity}</Badge></div><div className="text-slate-600 dark:text-slate-300">{x.message}</div><div className="text-xs text-slate-500">{stamp(x.created_at)}</div></div>
              <Button size="sm" variant="secondary" loading={resolve.isPending} onClick={() => resolve.mutate(x.id)}>Resolve</Button>
            </li>
          ))}</ul>
        )}
      </Card>
      <Card title={<span className="flex items-center gap-2"><Activity className="size-4" />API performance & Firestore usage (since last restart)</span>} padded={false}>
        {!m.data ? <div className="p-4"><Skeleton className="h-40" /></div> : (
          <>
            <div className="grid grid-cols-3 gap-3 p-4 text-sm">
              <div><div className="text-xs text-slate-500">Requests</div><div className="num text-lg font-semibold">{m.data.totals.requests}</div></div>
              <div><div className="text-xs text-slate-500">Document reads</div><div className="num text-lg font-semibold">{m.data.totals.reads}</div></div>
              <div><div className="text-xs text-slate-500">Writes</div><div className="num text-lg font-semibold">{m.data.totals.writes}</div></div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Route</th><th className="px-2 text-right">Calls</th><th className="px-2 text-right">Avg ms</th><th className="px-2 text-right">p95 ms</th><th className="px-2 text-right">Reads/call</th><th className="px-4 text-right">Reads</th></tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-white/5">{m.data.routes.slice(0, 40).map((r) => (
                  <tr key={r.route}><td className="px-4 py-1.5 font-mono">{r.route}</td><td className="num px-2 text-right">{r.count}</td><td className="num px-2 text-right">{r.avg_ms}</td>
                    <td className={`num px-2 text-right ${r.p95_ms > 1500 ? 'text-rose-600' : ''}`}>{r.p95_ms}</td><td className="num px-2 text-right">{r.reads_per_call}</td><td className="num px-4 text-right">{r.reads}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

import { BedDouble, CalendarClock, IndianRupee, RefreshCw, Search, Sparkles, TrendingUp, Wallet } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PageHeader } from '@/components/layout/AppShell'
import { Button, ErrorState, Input, Segmented, Skeleton, StatCard } from '@/components/ui'
import { get, post } from '@/lib/api'
import { useAuth, useCan } from '@/lib/auth'
import { cls, money } from '@/lib/format'
import type { Dashboard, Room } from '@/lib/types'
import { confirmDialog, toast } from '@/lib/ui'
import { useDashboard } from './hooks'
import { RoomCard } from './RoomCard'
import { RoomDrawer } from './RoomDrawer'
import { type Filter, floorOf, matchesFilter } from './roomState'

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t) }, [ms])
  return now
}

export function DashboardPage() {
  const { data, isLoading, error, refetch, isFetching } = useDashboard()
  const role = useAuth((s) => s.user?.role)
  const canRenew = useCan('room.update')
  const isHk = role === 'housekeeping'
  const [filter, setFilter] = useState<Filter>(isHk ? 'cleaning' : 'all')
  const [search, setSearch] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [renewing, setRenewing] = useState(false)
  const now = useNow()
  const qc = useQueryClient()

  const rooms = data?.rooms ?? []
  const visible = useMemo(() => rooms.filter((r) => matchesFilter(r, filter, search)), [rooms, filter, search])
  const floors = useMemo(() => {
    const m = new Map<string, typeof visible>()
    for (const r of visible) {
      const f = floorOf(r.id)
      m.set(f, [...(m.get(f) || []), r])
    }
    return [...m.entries()]
  }, [visible])
  const open = rooms.find((r) => r.id === openId) || null
  const due = rooms.filter((r) => r.status === 'occupied' && r._renewal?.due)

  const renewAll = async () => {
    if (!due.length) return
    const ok = await confirmDialog({
      title: `Renew ${due.length} room${due.length > 1 ? 's' : ''}?`,
      message: `Adds one more night's rent to the balance of rooms ${due.map((r) => r.id).join(', ')}.`,
      confirmLabel: 'Renew all',
    })
    if (!ok) return
    setRenewing(true)
    let done = 0
    for (const r of due) {
      try {
        await post(`/api/v2/rooms/${r.id}/renew`, { renewal_count: (r.renewal_count || 0) + 1 })
        done++
      } catch (e) {
        toast(`Room ${r.id}: ${e instanceof Error ? e.message : 'failed'}`, 'error')
      }
    }
    setRenewing(false)
    if (done) toast(`Renewed ${done} room${done > 1 ? 's' : ''}`)
    void qc.invalidateQueries({ queryKey: ['dashboard'] })
  }

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />

  const s = data?.stats
  const t = data?.today_summary
  const counts: Record<Filter, number> = {
    all: rooms.length,
    vacant: s?.vacant ?? 0,
    occupied: s?.occupied ?? 0,
    cleaning: s?.cleaning ?? 0,
    balances: s?.balances_count ?? 0,
  }

  return (
    <div>
      <PageHeader
        title={isHk ? 'Housekeeping' : 'Front desk'}
        subtitle={new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' }).format(now)}
        actions={
          <>
            {canRenew && due.length > 0 && (
              <Button variant="danger" size="sm" loading={renewing} icon={<CalendarClock className="size-4" />} onClick={renewAll}>
                Renew {due.length} due
              </Button>
            )}
            <Button variant="secondary" size="sm" icon={<RefreshCw className={isFetching ? 'size-4 animate-spin' : 'size-4'} />}
              onClick={() => qc.fetchQuery({ queryKey: ['dashboard'], queryFn: () => get<Dashboard>('/api/v2/dashboard', { fresh: true }) })}>
              Refresh
            </Button>
          </>
        }
      />

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Vacant" value={s?.vacant ?? 0} icon={<BedDouble className="size-4" />} tone="green" onClick={() => setFilter('vacant')} active={filter === 'vacant'} />
          <StatCard label="Occupied" value={s?.occupied ?? 0} hint={`${s?.total ?? 0} rooms`} icon={<BedDouble className="size-4" />} tone="brand" onClick={() => setFilter('occupied')} active={filter === 'occupied'} />
          <StatCard label="Cleaning" value={s?.cleaning ?? 0} icon={<Sparkles className="size-4" />} tone="amber" onClick={() => setFilter('cleaning')} active={filter === 'cleaning'} />
          {!isHk && <StatCard label="Balances due" value={money(s?.balances_total)} hint={`${s?.balances_count ?? 0} rooms`} icon={<Wallet className="size-4" />} tone="red" onClick={() => setFilter('balances')} active={filter === 'balances'} />}
          {t && <StatCard label="Collected today" value={money(t.cash + t.online)} hint={`Cash ${money(t.cash)} · UPI ${money(t.online)}`} icon={<IndianRupee className="size-4" />} tone="cyan" />}
          {t && <StatCard label="Net today" value={money(t.net - t.expenses)} hint={`Refunds ${money(t.refunds)} · Expenses ${money(t.expenses)}`} icon={<TrendingUp className="size-4" />} tone="accent" />}
        </div>
      )}

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          className="w-full overflow-x-auto sm:w-auto"
          size="sm"
          options={(['all', 'vacant', 'occupied', 'cleaning', 'balances'] as Filter[])
            .filter((f) => !(isHk && f === 'balances'))
            .map((f) => ({ value: f, label: <span className="capitalize">{f} <span className="num text-slate-400">{counts[f]}</span></span> }))}
        />
        <Legend />
        <div className="relative sm:ml-auto sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input aria-label="Search rooms or guests" placeholder="Room or guest name" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
      </div>

      {isLoading ? (
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-8">{Array.from({ length: 16 }).map((_, i) => <Skeleton key={i} className="h-[112px]" />)}</div>
      ) : visible.length === 0 ? (
        <p className="mt-10 text-center text-sm text-slate-500">No rooms match this filter.</p>
      ) : (
        floors.map(([floor, list]) => (
          <section key={floor} className="card mt-4 overflow-hidden" aria-label={floor}>
            <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-200 bg-slate-50/70 px-4 py-2.5 dark:border-white/[0.07] dark:bg-ink-800/40">
              <h2 className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{floor}</h2>
              <FloorCounts rooms={list} />
            </header>
            <div className="grid grid-cols-2 gap-2.5 p-3 sm:grid-cols-4 sm:p-4 md:grid-cols-5 xl:grid-cols-8 2xl:grid-cols-10">
              {list.map((r) => <RoomCard key={r.id} room={r} upcoming={data?.upcoming?.[r.id]} onOpen={setOpenId} now={now} />)}
            </div>
          </section>
        ))
      )}

      <RoomDrawer room={open} upcoming={open ? data?.upcoming?.[open.id] : undefined} uiConfig={data?.ui_config ?? {}} onClose={() => setOpenId(null)} />
    </div>
  )
}

const LEGEND = [
  ['bg-emerald-500', 'Vacant'], ['bg-brand-600 dark:bg-brand-400', 'Occupied'],
  ['bg-amber-500', 'Cleaning'], ['bg-sky-500', 'Ready to inspect'],
] as const

function Legend() {
  return (
    <ul className="hidden items-center gap-3 text-[11px] text-slate-500 xl:flex dark:text-slate-400" aria-label="Status colours">
      {LEGEND.map(([c, l]) => <li key={l} className="flex items-center gap-1.5"><span className={cls('h-3 w-[3px] rounded-full', c)} />{l}</li>)}
    </ul>
  )
}

function FloorCounts({ rooms }: { rooms: Room[] }) {
  const occ = rooms.filter((r) => r.status === 'occupied').length
  const cln = rooms.filter((r) => r.status === 'cleaning').length
  const pct = rooms.length ? Math.round((occ / rooms.length) * 100) : 0
  return (
    <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
      <span className="num">{rooms.length} rooms</span>
      <span className="num"><b className="font-semibold text-brand-700 dark:text-brand-300">{occ}</b> occupied</span>
      {cln > 0 && <span className="num"><b className="font-semibold text-amber-700 dark:text-amber-300">{cln}</b> cleaning</span>}
      <span className="hidden items-center gap-2 sm:flex" title={`${pct}% occupancy`}>
        <span className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
          <span className="block h-full rounded-full bg-brand-600 dark:bg-brand-400" style={{ width: `${pct}%` }} />
        </span>
        <span className="num">{pct}%</span>
      </span>
    </div>
  )
}

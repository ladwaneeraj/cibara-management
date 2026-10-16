import {
  BedDouble, Bell, ChartNoAxesCombined, ChevronRight, Clock, ExternalLink, KeyRound, LayoutGrid, LogOut, Menu, Moon,
  Receipt, Settings2, Sun, SunMoon, X,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { get } from '@/lib/api'
import { ChangePasswordDialog } from '@/features/auth/ChangePasswordDialog'
import { useAuth } from '@/lib/auth'
import { cls, initials } from '@/lib/format'
import { onRealtimeStatus, realtimeStatus, signOutRealtime } from '@/lib/realtime'
import { useUi } from '@/lib/ui'

type Section = 'Operations' | 'Finance' | 'System'
interface NavItem { to: string; label: string; icon: ReactNode; show: boolean; end?: boolean; section: Section }

export function useNav(): NavItem[] {
  const can = useAuth((s) => s.can)
  useAuth((s) => s.permissions) // re-render on permission change
  const i = 'size-[18px]'
  return [
    { to: '/', label: 'Rooms', icon: <LayoutGrid className={i} />, show: true, end: true, section: 'Operations' },
    { to: '/guests', label: 'Guest requests', icon: <Bell className={i} />, show: can('guest_request.handle'), section: 'Operations' },
    { to: '/bills', label: 'Bills', icon: <Receipt className={i} />, show: can('register.view'), section: 'Finance' },
    { to: '/finance', label: can('analytics.view') ? 'Reports' : 'Finance', icon: <ChartNoAxesCombined className={i} />, show: can('register.view') || can('analytics.view'), section: 'Finance' },
    { to: '/admin', label: 'Admin', icon: <Settings2 className={i} />, show: can('user.manage') || can('settings.update') || can('logs.view'), section: 'System' },
    { to: '/more', label: 'More modules', icon: <BedDouble className={i} />, show: can('register.view'), section: 'System' },
  ]
}

/** Public /api/v2/config — used for the environment chip (UAT vs PROD). */
function useEnv(): string | null {
  const q = useQuery({
    queryKey: ['public-config'],
    queryFn: () => get<{ env: string }>('/api/v2/config'),
    staleTime: Infinity,
    retry: false,
  })
  return q.data?.env ?? null
}

function EnvChip({ dark = false }: { dark?: boolean }) {
  const env = useEnv()
  if (!env || env.toUpperCase() === 'PROD') return null
  return (
    <span title="Test environment — data here is not live"
      className={cls('rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider',
        dark ? 'bg-accent-400/15 text-accent-300 ring-1 ring-inset ring-accent-400/30' : 'bg-accent-100 text-accent-700 ring-1 ring-inset ring-accent-600/20')}>
      {env.toUpperCase()}
    </span>
  )
}

function IstClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t) }, [])
  const fmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
  return (
    <span className="hidden items-center gap-1.5 text-xs text-slate-500 md:flex dark:text-slate-400" title="India Standard Time">
      <Clock className="size-3.5" /> <span className="num">{fmt.format(now)}</span>
    </span>
  )
}

function Breadcrumb() {
  const loc = useLocation()
  const nav = useNav()
  const cur = nav.find((n) => (n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to) && n.to !== '/')) ?? nav[0]
  return (
    <div className="hidden min-w-0 items-center gap-1.5 text-sm sm:flex">
      <span className="text-slate-500 dark:text-slate-400">{cur.section}</span>
      <ChevronRight className="size-3.5 text-slate-400" />
      <span className="truncate font-semibold text-slate-800 dark:text-slate-100">{cur.label}</span>
    </div>
  )
}

function RealtimeDot() {
  const [s, setS] = useState(realtimeStatus())
  useEffect(() => { const off = onRealtimeStatus(setS); return () => { off() } }, [])
  const map = {
    live: ['bg-emerald-500', 'Live updates on'],
    connecting: ['bg-amber-400 animate-pulse', 'Connecting live updates…'],
    failed: ['bg-slate-400', 'Live updates unavailable — refreshing every 15 s'],
    off: ['bg-slate-400', 'Live updates off'],
  } as const
  const [c, label] = map[s]
  return (
    <span className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 dark:border-white/10 dark:text-slate-400" title={label}>
      <span className={cls('size-2 rounded-full', c)} aria-hidden />
      <span className="hidden lg:inline">{s === 'live' ? 'Live' : s === 'connecting' ? 'Connecting' : 'Polling'}</span>
    </span>
  )
}

function ThemeButton() {
  const theme = useUi((s) => s.theme)
  const setTheme = useUi((s) => s.setTheme)
  const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : SunMoon
  return (
    <button type="button" onClick={() => setTheme(next)} title={`Theme: ${theme}`} aria-label={`Theme: ${theme}. Switch to ${next}`}
      className="rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-white/5 dark:hover:text-slate-200">
      <Icon className="size-[18px]" />
    </button>
  )
}

function UserMenu() {
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState(false)
  if (!user) return null
  const signOut = async () => {
    setOpen(false)
    await signOutRealtime()
    await logout()
    qc.clear()
  }
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        className="flex items-center gap-2 rounded-lg border border-transparent py-1 pl-1 pr-2 hover:border-slate-200 hover:bg-slate-50 dark:hover:border-white/10 dark:hover:bg-white/5">
        <span className="grid size-8 place-items-center rounded-md bg-ink-800 text-xs font-bold text-accent-300 dark:bg-ink-700">{initials(user.name)}</span>
        <span className="hidden text-left sm:block">
          <span className="block text-sm font-medium leading-4">{user.name}</span>
          <span className="block text-[11px] text-slate-500">{user.roleLabel}</span>
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="card absolute right-0 z-40 mt-2 w-56 overflow-hidden p-1 shadow-xl">
            <button role="menuitem" type="button" onClick={() => { setOpen(false); setPw(true) }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-white/5">
              <KeyRound className="size-4" /> Change password
            </button>
            <button role="menuitem" type="button" onClick={signOut}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10">
              <LogOut className="size-4" /> Sign out
            </button>
          </div>
        </>
      )}
      <ChangePasswordDialog open={pw} onClose={() => setPw(false)} />
    </div>
  )
}

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const nav = useNav().filter((n) => n.show)
  const sections: Section[] = ['Operations', 'Finance', 'System']
  const item = (active: boolean) => cls(
    'group relative flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition-colors',
    active ? 'bg-white/[0.08] text-white' : 'text-slate-300/80 hover:bg-white/[0.04] hover:text-white',
  )
  return (
    <nav className="flex flex-col gap-5" aria-label="Main">
      {sections.map((sec) => {
        const items = nav.filter((n) => n.section === sec)
        if (!items.length && sec !== 'System') return null // System always has Classic screens
        return (
          <div key={sec}>
            <div className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{sec}</div>
            <div className="flex flex-col gap-0.5">
              {items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} onClick={onNavigate} className={({ isActive }) => item(isActive)}>
                  {({ isActive }) => (
                    <>
                      {isActive && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-accent-400" />}
                      <span className={isActive ? 'text-accent-300' : 'text-slate-400 group-hover:text-slate-200'}>{n.icon}</span>
                      {n.label}
                    </>
                  )}
                </NavLink>
              ))}
              {sec === 'System' && (
                <a href="/legacy" className={item(false)}>
                  <ExternalLink className="size-[18px] text-slate-400" /> Classic screens
                </a>
              )}
            </div>
          </div>
        )
      })}
    </nav>
  )
}

function Brand() {
  return (
    <div className="flex items-center gap-3 px-1">
      <div className="grid size-9 place-items-center rounded-lg bg-accent-400 text-[15px] font-black text-ink-950 shadow-sm">C</div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-tight text-white">Cibara Comforts <EnvChip dark /></div>
        <div className="text-[11px] text-slate-400">Property management</div>
      </div>
    </div>
  )
}

export function AppShell() {
  const sidebarOpen = useUi((s) => s.sidebarOpen)
  const setSidebar = useUi((s) => s.setSidebar)
  const loc = useLocation()
  const nav = useNav().filter((n) => n.show).slice(0, 4)
  useEffect(() => setSidebar(false), [loc.pathname, setSidebar])

  return (
    <div className="min-h-dvh lg:pl-60">
      {/* desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-ink-950 bg-ink-900 lg:flex">
        <div className="flex h-14 items-center border-b border-white/[0.06] px-4"><Brand /></div>
        <div className="flex-1 overflow-y-auto px-3 py-5"><SideNav /></div>
        <div className="border-t border-white/[0.06] px-4 py-3 text-[11px] leading-relaxed text-slate-500">
          Bookings, staff, laundry and maintenance open in the classic screens.
        </div>
      </aside>

      {/* mobile drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/60" onClick={() => setSidebar(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-ink-900">
            <div className="flex h-14 items-center justify-between border-b border-white/[0.06] px-4">
              <Brand />
              <button type="button" aria-label="Close menu" onClick={() => setSidebar(false)} className="rounded-md p-2 text-slate-400"><X className="size-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-5"><SideNav onNavigate={() => setSidebar(false)} /></div>
          </aside>
        </div>
      )}

      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-3 sm:px-5 dark:border-white/[0.07] dark:bg-ink-900">
        <button type="button" aria-label="Open menu" onClick={() => setSidebar(true)} className="rounded-md p-2 text-slate-600 lg:hidden dark:text-slate-300">
          <Menu className="size-5" />
        </button>
        <span className="lg:hidden"><EnvChip /></span>
        <Breadcrumb />
        <div className="flex-1" />
        <IstClock />
        <RealtimeDot />
        <ThemeButton />
        <div className="h-6 w-px bg-slate-200 dark:bg-white/10" aria-hidden />
        <UserMenu />
      </header>

      <main className="mx-auto max-w-[1600px] px-3 pb-24 pt-5 sm:px-6 lg:pb-10">
        <Outlet />
      </main>

      {/* mobile bottom nav */}
      <nav aria-label="Quick" className="fixed inset-x-0 bottom-0 z-30 grid border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden dark:border-white/10 dark:bg-ink-900"
        style={{ gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))` }}>
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}
            className={({ isActive }) => cls('relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium', isActive ? 'text-brand-700 dark:text-accent-300' : 'text-slate-500')}>
            {({ isActive }) => (
              <>
                {isActive && <span aria-hidden className="absolute inset-x-6 top-0 h-0.5 rounded-b bg-brand-600 dark:bg-accent-400" />}
                {n.icon}
                {n.label.split(' ')[0]}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-[22px] dark:text-white">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

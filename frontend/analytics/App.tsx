import { ArrowLeft, RefreshCw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Card, EmptyState, ErrorState, Skeleton, Spinner } from '@/components/ui'
import { useAuth, useCan } from '@/lib/auth'
import { cls, istDate } from '@/lib/format'
import { useAnalyticsOverview, useDemographics, useFinancials, useGstr1, useRefreshOverview } from './api'
import { Reveal } from './anim'
import { RangePicker } from './RangePicker'
import { rangeFor, type Range } from './range'
import { BookingPace } from './sections/BookingPace'
import { ChannelMix } from './sections/ChannelMix'
import { Customers } from './sections/Customers'
import { DemographicsBody } from './sections/Demographics'
import { Financials } from './sections/Financials'
import { Findings } from './sections/Findings'
import { Overview } from './sections/Overview'
import { Reports } from './sections/Reports'
import { Seasonality } from './sections/Seasonality'
import { StayShape } from './sections/StayShape'

type Tab = 'analytics' | 'reports'

/** Inclusive day span of the selected range, for per-day averages. */
function spanDays(from: string, to: string): number {
  const n = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
  return Number.isFinite(n) && n > 0 ? n : 1
}

/** Where an unauthenticated visitor goes: the classic sign-in page. */
function toClassicLogin() {
  window.location.assign('/login')
}

/**
 * Session gate. The access JWT lives in memory (lib/auth), so a fresh page load
 * restores the session from the refresh cookie (`bootstrap`, called by Root).
 * Anonymous → the classic login; signed in without `analytics.view` → a note.
 */
export function AuthGate({ children, redirect = toClassicLogin }: { children: ReactNode; redirect?: () => void }) {
  const status = useAuth((s) => s.status)
  const allowed = useCan('analytics.view')

  useEffect(() => {
    if (status === 'anonymous') redirect()
  }, [status, redirect])

  if (status !== 'authenticated') {
    return <div className="grid min-h-dvh place-items-center bg-canvas dark:bg-ink-950"><Spinner className="size-8" /></div>
  }
  if (!allowed) {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas p-6 dark:bg-ink-950">
        <Card className="max-w-md">
          <EmptyState
            title="You do not have access to Analytics"
            hint="Analytics is limited to administrators. Ask an admin if you need it."
            action={<a className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300" href="/">Back to app</a>}
          />
        </Card>
      </div>
    )
  }
  return <>{children}</>
}

/** "Updated 3:34 pm" in the property's time zone. */
function updatedAt(iso?: string): string | null {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return null
  return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })
}

function LoadingSections() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading analytics">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
      <Skeleton className="h-72" />
      <Skeleton className="h-48" />
    </div>
  )
}

/** Segmented Analytics / Reports switch. */
function Tabs({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  const items: { key: Tab; label: string }[] = [{ key: 'analytics', label: 'Analytics' }, { key: 'reports', label: 'Reports' }]
  return (
    <div role="tablist" aria-label="View" className="inline-flex rounded-lg bg-slate-100 p-1 dark:bg-ink-900">
      {items.map((it) => (
        <button
          key={it.key}
          role="tab"
          aria-selected={value === it.key}
          onClick={() => onChange(it.key)}
          className={cls(
            'rounded-md px-4 py-1.5 text-sm font-medium transition',
            value === it.key
              ? 'bg-white text-slate-900 shadow-sm dark:bg-ink-700 dark:text-slate-100'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

export function App() {
  const [range, setRange] = useState<Range>(() => rangeFor('7d', istDate()))
  const [tab, setTab] = useState<Tab>('analytics')
  const q = useAnalyticsOverview(range.from, range.to)
  const fin = useFinancials(range.from, range.to)
  const demo = useDemographics()
  const gstr = useGstr1(range.from, range.to, tab === 'reports')
  const fresh = useRefreshOverview(range.from, range.to)
  const data = q.data
  const stamp = updatedAt(data?.generated_at)
  const days = spanDays(range.from, range.to)

  const refreshAll = () => {
    void fresh.refresh().catch(() => {})
    void fin.refetch(); void demo.refetch()
    if (tab === 'reports') void gstr.refetch()
  }

  return (
    <div className="min-h-dvh bg-canvas text-slate-900 dark:bg-ink-950 dark:text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-white/[0.07] dark:bg-ink-900/90">
        <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <h1 className="text-base font-semibold tracking-tight sm:text-lg">Analytics &amp; Reports</h1>
          <a href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
            <ArrowLeft className="size-4" aria-hidden /> Back to app
          </a>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 sm:gap-5 sm:px-6 sm:py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={tab} onChange={setTab} />
            <RangePicker value={range} onChange={setRange} />
          </div>
          <div className="flex items-center gap-2">
            {stamp && <span className="text-xs text-slate-500 dark:text-slate-400">Updated {stamp}</span>}
            <Button variant="secondary" size="sm" onClick={refreshAll} disabled={fresh.pending} aria-label="Refresh">
              <RefreshCw className={cls('size-4', fresh.pending && 'animate-spin')} aria-hidden /> Refresh
            </Button>
          </div>
        </div>

        {tab === 'reports' ? (
          <Reveal>
            {fin.data ? <Reports data={fin.data} gstr={gstr.data} gstrLoading={gstr.isLoading} />
              : fin.isError ? <Card><ErrorState error={fin.error} onRetry={() => void fin.refetch()} /></Card>
              : <Skeleton className="h-96" />}
          </Reveal>
        ) : (
          <>
            {data && <Reveal><Findings items={data.findings ?? []} /></Reveal>}

            <Reveal delay={40}>
              {fin.data ? <Financials data={fin.data} days={days} />
                : fin.isError ? <Card><ErrorState error={fin.error} onRetry={() => void fin.refetch()} /></Card>
                : <Skeleton className="h-96" />}
            </Reveal>

            {data ? (
              <div className={cls('flex flex-col gap-4 sm:gap-5', q.isPlaceholderData && 'opacity-60 transition-opacity')}>
                <Reveal delay={60}><Overview data={data} /></Reveal>
                <Reveal delay={80}><ChannelMix data={data.channel_mix} /></Reveal>
                <Reveal delay={100}><BookingPace data={data.pace} /></Reveal>
                <Reveal delay={120}><Seasonality data={data.seasonality} /></Reveal>
                <Reveal delay={140}><StayShape data={data.los_leadtime} /></Reveal>
              </div>
            ) : q.isError ? (
              <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>
            ) : (
              <LoadingSections />
            )}

            {/* Guests = CRM insights + demographics, merged into one section. */}
            <Reveal>
              <section aria-labelledby="sec-guests" className="space-y-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <h2 id="sec-guests" className="text-[13px] font-semibold tracking-tight text-slate-800 dark:text-slate-100">Guests</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">CRM &amp; demographics</p>
                </div>
                <Customers />
                {demo.data ? <DemographicsBody data={demo.data} /> : demo.isError ? null : <Skeleton className="h-64" />}
              </section>
            </Reveal>
          </>
        )}
      </main>
    </div>
  )
}

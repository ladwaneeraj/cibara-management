import { ArrowLeft, RefreshCw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Card, EmptyState, ErrorState, Skeleton, Spinner } from '@/components/ui'
import { useAuth, useCan } from '@/lib/auth'
import { cls, istDate } from '@/lib/format'
import { useAnalyticsOverview, useRefreshOverview } from './api'
import { RangePicker } from './RangePicker'
import { rangeFor, type Range } from './range'
import { BookingPace } from './sections/BookingPace'
import { ChannelMix } from './sections/ChannelMix'
import { Customers } from './sections/Customers'
import { Findings } from './sections/Findings'
import { Overview } from './sections/Overview'
import { Seasonality } from './sections/Seasonality'
import { StayShape } from './sections/StayShape'

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

export function App() {
  const [range, setRange] = useState<Range>(() => rangeFor('7d', istDate()))
  const q = useAnalyticsOverview(range.from, range.to)
  const fresh = useRefreshOverview(range.from, range.to)
  const data = q.data
  const stamp = updatedAt(data?.generated_at)

  return (
    <div className="min-h-dvh bg-canvas text-slate-900 dark:bg-ink-950 dark:text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-white/[0.07] dark:bg-ink-900/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <h1 className="text-base font-semibold tracking-tight sm:text-lg">Analytics</h1>
          <a href="/" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
            <ArrowLeft className="size-4" aria-hidden /> Back to app
          </a>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4 sm:gap-5 sm:px-6 sm:py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <RangePicker value={range} onChange={setRange} />
          <div className="flex items-center gap-2">
            {stamp && <span className="text-xs text-slate-500 dark:text-slate-400">Updated {stamp}</span>}
            <Button variant="secondary" size="sm" onClick={() => void fresh.refresh().catch(() => {})} disabled={fresh.pending} aria-label="Refresh">
              <RefreshCw className={cls('size-4', fresh.pending && 'animate-spin')} aria-hidden /> Refresh
            </Button>
          </div>
        </div>

        {data ? (
          <div className={cls('flex flex-col gap-4 sm:gap-5', q.isPlaceholderData && 'opacity-60 transition-opacity')}>
            <Findings items={data.findings ?? []} />
            <Overview data={data} />
            <ChannelMix data={data.channel_mix} />
            <BookingPace data={data.pace} />
            <Seasonality data={data.seasonality} />
            <StayShape data={data.los_leadtime} />
          </div>
        ) : q.isError ? (
          <Card><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>
        ) : (
          <LoadingSections />
        )}

        <Customers />
      </main>
    </div>
  )
}

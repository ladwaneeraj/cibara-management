import { ArrowLeft } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { Card, EmptyState, Spinner } from '@/components/ui'
import { useAuth, useCan } from '@/lib/auth'

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

/** One titled block of the page. Later tasks swap the body for the real section. */
function Placeholder({ title }: { title: string }) {
  return (
    <Card title={title}>
      <div className="grid h-24 place-items-center"><Spinner /></div>
    </Card>
  )
}

export function App() {
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
        <Placeholder title="Overview" />
        <Placeholder title="Channel mix" />
        <Placeholder title="Booking pace" />
        <Placeholder title="Seasonality" />
        <Placeholder title="Customers" />
      </main>
    </div>
  )
}

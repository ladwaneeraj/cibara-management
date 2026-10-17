import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { ConfirmHost, StepUpHost, Toaster } from '@/components/layout/Overlays'
import { Spinner } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { onAuthChange, useAuth } from '@/lib/auth'
import { signOutRealtime, startRealtime } from '@/lib/realtime'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { LoginPage } from '@/features/auth/LoginPage'

// Heavier, less-used screens are code-split.
const BillsPage = lazy(() => import('@/features/bills/BillsPage').then((m) => ({ default: m.BillsPage })))
const FinancePage = lazy(() => import('@/features/reports/FinancePage').then((m) => ({ default: m.FinancePage })))
const AdminPage = lazy(() => import('@/features/admin/AdminPage').then((m) => ({ default: m.AdminPage })))
const GuestRequestsPage = lazy(() => import('@/features/guest/GuestRequestsPage').then((m) => ({ default: m.GuestRequestsPage })))
const MorePage = lazy(() => import('@/features/legacy/MorePage').then((m) => ({ default: m.MorePage })))

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (n, e) => !(e instanceof ApiError && [400, 401, 403, 404, 422].includes(e.status)) && n < 2,
        refetchOnWindowFocus: false,
        staleTime: 15_000,
      },
    },
  })
}

function Loading() {
  return <div className="grid min-h-[50vh] place-items-center"><Spinner className="size-7" /></div>
}

function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status)
  const loc = useLocation()
  if (status === 'booting') return <div className="grid min-h-dvh place-items-center bg-slate-50 dark:bg-ink-950"><Spinner className="size-8" /></div>
  if (status !== 'authenticated') return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />
  return <>{children}</>
}

function RequirePerm({ any, children }: { any: string[]; children: ReactNode }) {
  const can = useAuth((s) => s.can)
  useAuth((s) => s.permissions)
  return any.some((p) => can(p)) ? <>{children}</> : <Navigate to="/" replace />
}

function Realtime({ qc }: { qc: QueryClient }) {
  useEffect(() => {
    const start = () => {
      const s = useAuth.getState()
      if (s.status === 'authenticated' && s.user) {
        void startRealtime(qc, { customToken: s.firebaseToken, uid: s.user.authUid, role: s.user.role })
      }
    }
    start()
    const off = onAuthChange((st) => {
      if (st === 'anonymous') { void signOutRealtime(); qc.clear() }
    })
    const unsub = useAuth.subscribe((s, prev) => { if (s.user?.userId !== prev.user?.userId && s.status === 'authenticated') start() })
    return () => { off(); unsub() }
  }, [qc])
  return null
}

export function AppRoutes() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth><AppShell /></RequireAuth>}>
          <Route index element={<DashboardPage />} />
          <Route path="bills" element={<RequirePerm any={['register.view']}><BillsPage /></RequirePerm>} />
          <Route path="finance" element={<RequirePerm any={['register.view', 'analytics.view']}><FinancePage /></RequirePerm>} />
          <Route path="guests" element={<RequirePerm any={['guest_request.handle']}><GuestRequestsPage /></RequirePerm>} />
          <Route path="admin" element={<RequirePerm any={['user.manage', 'settings.update', 'logs.view']}><AdminPage /></RequirePerm>} />
          <Route path="more" element={<MorePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}

export function App({ queryClient }: { queryClient: QueryClient }) {
  const bootstrap = useAuth((s) => s.bootstrap)
  useEffect(() => { void bootstrap() }, [bootstrap])
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/app">
        <AppRoutes />
        <Realtime qc={queryClient} />
        <Toaster />
        <ConfirmHost />
        <StepUpHost />
      </BrowserRouter>
    </QueryClientProvider>
  )
}

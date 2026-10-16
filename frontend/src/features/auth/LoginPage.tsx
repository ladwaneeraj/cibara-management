import { BedDouble, Eye, EyeOff, LogIn, Receipt, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { Button, Input, Notice } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth'

export function LoginPage() {
  const status = useAuth((s) => s.status)
  const login = useAuth((s) => s.login)
  const notice = useAuth((s) => s.notice)
  const clearNotice = useAuth((s) => s.clearNotice)
  const loc = useLocation()
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (status === 'authenticated') {
    const to = (loc.state as { from?: string } | null)?.from || '/'
    return <Navigate to={to} replace />
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    clearNotice()
    if (!userId.trim() || !password) {
      setError('Please enter your User ID and password.')
      return
    }
    setBusy(true)
    try {
      await login(userId.trim(), password)
    } catch (err) {
      setPassword('')
      setError(err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-dvh bg-white lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] dark:bg-ink-950">
      {/* brand panel */}
      <aside className="relative hidden overflow-hidden bg-ink-900 lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(to_right,#fff_1px,transparent_1px),linear-gradient(to_bottom,#fff_1px,transparent_1px)] [background-size:44px_44px]" />
        <div aria-hidden className="absolute inset-x-0 top-0 h-1 bg-accent-400" />
        <div className="relative flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg bg-accent-400 text-lg font-black text-ink-950">C</div>
          <div>
            <div className="text-base font-semibold text-white">Cibara Comforts</div>
            <div className="text-xs text-slate-400">Property management system</div>
          </div>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight text-white">Front desk, billing and GST — in one place.</h2>
          <ul className="mt-8 space-y-4 text-sm text-slate-300">
            {[
              [BedDouble, 'Live room board', 'Check-ins, cleaning and balances update across every desk.'],
              [Receipt, 'GST-ready invoices', 'Same bill numbers, tax split and PDFs as before.'],
              [ShieldCheck, 'Role-based access', 'Admins, managers and staff each see what they need.'],
            ].map(([Icon, t, d]) => {
              const I = Icon as typeof BedDouble
              return (
                <li key={t as string} className="flex gap-3">
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-white/[0.06] text-accent-300 ring-1 ring-inset ring-white/10"><I className="size-4" /></span>
                  <span><span className="block font-medium text-white">{t as string}</span><span className="text-slate-400">{d as string}</span></span>
                </li>
              )
            })}
          </ul>
        </div>
        <p className="relative text-xs text-slate-500">© Cibara Comforts</p>
      </aside>

      {/* form */}
      <main className="flex items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="grid size-10 place-items-center rounded-lg bg-accent-400 text-lg font-black text-ink-950">C</div>
            <div className="text-base font-semibold">Cibara Comforts</div>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">Sign in</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Use the User ID and password your administrator gave you.</p>
          <form onSubmit={submit} noValidate className="mt-8">
            {notice && <div className="mb-4"><Notice tone="blue">{notice}</Notice></div>}
            <label htmlFor="user-id" className="label">User ID</label>
            <Input id="user-id" name="userId" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              value={userId} onChange={(e) => setUserId(e.target.value)} maxLength={64} className="h-11" placeholder="e.g. neeraj" />
            <label htmlFor="password" className="label mt-5">Password</label>
            <div className="relative">
              <Input id="password" name="password" type={show ? 'text' : 'password'} autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)} maxLength={128} className="h-11 pr-11" placeholder="••••••••" />
              <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 grid w-11 place-items-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {error && <p role="alert" className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>}
            <Button type="submit" size="lg" loading={busy} icon={<LogIn className="size-4" />} className="mt-6 w-full">
              Sign in
            </Button>
          </form>
          <p className="mt-8 border-t border-slate-200 pt-4 text-xs text-slate-500 dark:border-white/10">Forgot your password? Ask an administrator to reset it.</p>
        </div>
      </main>
    </div>
  )
}

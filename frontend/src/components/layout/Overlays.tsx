import { useEffect, useState } from 'react'
import { CheckCircle2, Info, XCircle } from 'lucide-react'
import { Button, Modal } from '@/components/ui'
import { post } from '@/lib/api'
import { cls } from '@/lib/format'
import { useUi } from '@/lib/ui'

const STEP_UP_LABELS: Record<string, string> = {
  cancel_bill: 'Cancel this bill',
  credit_note: 'Issue this credit note',
  bad_debt: 'Write off as bad debt',
  writeoff: 'Write off this balance',
  discount: 'Apply this discount',
  refund: 'Process this refund',
}

export function Toaster() {
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismiss)
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:items-end">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={cls(
            'pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl px-4 py-3 text-left text-sm shadow-lg ring-1 backdrop-blur',
            t.tone === 'success' && 'bg-emerald-600/95 text-white ring-emerald-500',
            t.tone === 'error' && 'bg-rose-600/95 text-white ring-rose-500',
            t.tone === 'info' && 'bg-ink-900/95 text-white ring-white/10',
          )}
        >
          {t.tone === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : t.tone === 'error' ? <XCircle className="mt-0.5 size-4 shrink-0" /> : <Info className="mt-0.5 size-4 shrink-0" />}
          <span>{t.message}</span>
        </button>
      ))}
    </div>
  )
}

export function ConfirmHost() {
  const req = useUi((s) => s.confirmReq)
  const close = useUi((s) => s.closeConfirm)
  return (
    <Modal
      open={!!req}
      onClose={() => close(false)}
      title={req?.title ?? ''}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>Cancel</Button>
          <Button variant={req?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{req?.confirmLabel ?? 'Confirm'}</Button>
        </>
      }
    >
      <p className="text-sm text-slate-600 dark:text-slate-300">{req?.message}</p>
    </Modal>
  )
}

/**
 * Step-up RE-AUTH prompt. The admin re-enters their own password to confirm a
 * money-leaving action (not a two-person approval); on success /api/v2/authorize
 * returns a single-use token the api client replays as X-Step-Up-Token.
 */
export function StepUpHost() {
  const req = useUi((s) => s.stepUpReq)
  const close = useUi((s) => s.closeStepUp)
  const [pass, setPass] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setPass('')
    setErr('')
    setBusy(false)
  }, [req])

  const amt = req?.amount ? `₹${req.amount.toLocaleString('en-IN')}` : ''

  async function submit() {
    if (!req) return
    if (!pass) {
      setErr('Enter your password.')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const r = await post<{ token: string }>('/api/v2/authorize', {
        action: req.action,
        amount: req.amount || 0,
        password: pass,
      })
      close(r.token)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Confirmation failed.')
      setBusy(false)
    }
  }

  return (
    <Modal
      open={!!req}
      onClose={() => close(null)}
      title={req ? `${STEP_UP_LABELS[req.action] ?? 'Admin confirmation'}?` : ''}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => close(null)}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>{busy ? 'Checking…' : 'Confirm'}</Button>
        </>
      }
    >
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Re-enter your password to confirm{amt ? ` ${amt}` : ''}. Money-leaving actions need admin confirmation.
      </p>
      <input
        type="password"
        autoComplete="current-password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        placeholder="Your password"
        className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
      />
      {err && <p className="mt-2 text-xs text-rose-600">{err}</p>}
    </Modal>
  )
}

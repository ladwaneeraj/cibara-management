import { CheckCircle2, Info, XCircle } from 'lucide-react'
import { Button, Modal } from '@/components/ui'
import { cls } from '@/lib/format'
import { useUi } from '@/lib/ui'

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

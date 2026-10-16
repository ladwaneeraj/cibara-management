import { X, Loader2, AlertTriangle, Inbox } from 'lucide-react'
import {
  cloneElement, forwardRef, isValidElement, useEffect, useId, useRef, type ReactElement,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { cls } from '@/lib/format'

/* ─── Button ────────────────────────────────────────────────────────────── */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'subtle' | 'accent'
const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700 active:bg-brand-800 dark:bg-brand-500 dark:hover:bg-brand-400',
  secondary: 'bg-white text-slate-700 border border-slate-300 shadow-sm hover:bg-slate-50 hover:border-slate-400 dark:bg-ink-800 dark:text-slate-200 dark:border-white/12 dark:hover:bg-ink-700',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/5',
  danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-700',
  success: 'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700',
  subtle: 'bg-brand-50 text-brand-700 hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:hover:bg-brand-500/20',
  accent: 'bg-accent-400 text-ink-950 shadow-sm hover:bg-accent-300 active:bg-accent-500',
}
const sizes = { sm: 'h-8 px-3 text-xs gap-1.5', md: 'h-9 px-3.5 text-sm gap-2', lg: 'h-11 px-5 text-sm gap-2' }

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: keyof typeof sizes
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cls(
        'inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-55 select-none',
        variants[variant], sizes[size], className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  )
})

/* ─── Badge ─────────────────────────────────────────────────────────────── */

type Tone = 'slate' | 'brand' | 'green' | 'amber' | 'red' | 'blue' | 'violet' | 'cyan' | 'accent'
const tones: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-500/15 dark:bg-white/10 dark:text-slate-300 dark:ring-white/10',
  brand: 'bg-brand-50 text-brand-700 ring-brand-600/15 dark:bg-brand-500/15 dark:text-brand-300 dark:ring-brand-400/20',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/20',
  red: 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-400/20',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-400/20',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-400/20',
  cyan: 'bg-teal-50 text-teal-700 ring-teal-600/20 dark:bg-teal-500/15 dark:text-teal-300 dark:ring-teal-400/20',
  accent: 'bg-accent-50 text-accent-700 ring-accent-600/20 dark:bg-accent-400/15 dark:text-accent-300 dark:ring-accent-400/20',
}
/** Solid colour per tone — KPI accent bars, legend dots. */
export const toneBar: Record<Tone, string> = {
  slate: 'bg-slate-400', brand: 'bg-brand-500', green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-rose-500',
  blue: 'bg-sky-500', violet: 'bg-violet-500', cyan: 'bg-teal-500', accent: 'bg-accent-400',
}

export function Badge({ tone = 'slate', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cls('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold leading-4 ring-1 ring-inset', tones[tone], className)}>
      {children}
    </span>
  )
}

/* ─── Card ──────────────────────────────────────────────────────────────── */

export function Card({ children, className, title, action, padded = true }: {
  children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode; padded?: boolean
}) {
  return (
    <section className={cls('card', className)}>
      {(title || action) && (
        <header className="flex min-h-12 items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5 sm:px-5 dark:border-white/[0.07]">
          <h2 className="text-[13px] font-semibold tracking-tight text-slate-800 dark:text-slate-100">{title}</h2>
          {action}
        </header>
      )}
      <div className={padded ? 'p-4 sm:p-5' : ''}>{children}</div>
    </section>
  )
}

/** KPI tile: coloured left rule, small-caps label, large tabular figure. */
export function StatCard({ label, value, hint, icon, tone = 'brand', onClick, active }: {
  label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: Tone; onClick?: () => void; active?: boolean
}) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick, 'aria-pressed': !!active } : {})}
      className={cls(
        'card relative overflow-hidden py-3 pl-4 pr-3 text-left transition sm:py-3.5 sm:pl-5 sm:pr-4',
        onClick && 'hover:border-slate-300 hover:shadow-md dark:hover:border-white/15',
        active && 'border-brand-400 ring-1 ring-brand-400 dark:border-brand-400',
      )}
    >
      <span aria-hidden className={cls('absolute inset-y-0 left-0 w-[3px]', toneBar[tone])} />
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</span>
        {icon && <span className={cls('grid size-7 shrink-0 place-items-center rounded-md ring-1 ring-inset', tones[tone])}>{icon}</span>}
      </div>
      <div className="num mt-1 text-xl font-semibold tracking-tight text-slate-900 sm:text-[26px] sm:leading-8 dark:text-white">{value}</div>
      {hint && <div className="mt-0.5 text-xs leading-snug text-slate-500 dark:text-slate-400">{hint}</div>}
    </Tag>
  )
}

/* ─── Form controls ─────────────────────────────────────────────────────── */

export function Field({ label, error, hint, children, className, htmlFor }: {
  label?: ReactNode; error?: string | null; hint?: ReactNode; children: ReactNode; className?: string; htmlFor?: string
}) {
  // Associate the label with a single form control child automatically.
  const auto = useId()
  let id = htmlFor
  let content = children
  if (!id && isValidElement(children)) {
    const props = children.props as { id?: string }
    id = props.id || auto
    if (!props.id) content = cloneElement(children as ReactElement<{ id?: string }>, { id })
  }
  return (
    <div className={className}>
      {label && <label htmlFor={id} className="label">{label}</label>}
      {content}
      {error ? <p className="mt-1 text-xs text-rose-600" role="alert">{error}</p>
        : hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cls('input', className)} {...p} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return <select ref={ref} className={cls('input pr-8', className)} {...p}>{children}</select>
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cls('input min-h-20', className)} {...p} />
})

export function Segmented<T extends string>({ value, onChange, options, className, size = 'md' }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; disabled?: boolean }[]; className?: string; size?: 'sm' | 'md'
}) {
  return (
    <div role="radiogroup" className={cls('inline-flex rounded-lg border border-slate-200 bg-slate-100/80 p-0.5 dark:border-white/10 dark:bg-white/5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cls(
            'flex-1 rounded-md font-medium transition disabled:opacity-40',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
            value === o.value
              ? 'bg-white text-brand-700 shadow-sm ring-1 ring-slate-200 dark:bg-ink-700 dark:text-white dark:ring-white/10'
              : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  const id = useId()
  return (
    <label htmlFor={id} className={cls('flex cursor-pointer items-center justify-between gap-4 py-1', disabled && 'opacity-50')}>
      <span className="text-sm text-slate-700 dark:text-slate-200">{label}</span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cls('relative h-6 w-11 shrink-0 rounded-full transition', checked ? 'bg-brand-600' : 'bg-slate-300 dark:bg-white/15')}
      >
        <span className={cls('absolute top-0.5 size-5 rounded-full bg-white shadow transition', checked ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </label>
  )
}

/* ─── Feedback ──────────────────────────────────────────────────────────── */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cls('size-5 animate-spin text-brand-500', className)} aria-label="Loading" />
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cls('animate-pulse rounded-xl bg-slate-200/70 dark:bg-white/5', className)} />
}

export function EmptyState({ title, hint, icon, action }: { title: string; hint?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-white/5">{icon ?? <Inbox className="size-6" />}</div>
      <p className="font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {hint && <p className="max-w-sm text-sm text-slate-500">{hint}</p>}
      {action}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong'
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-rose-100 text-rose-600 dark:bg-rose-500/15"><AlertTriangle className="size-6" /></div>
      <p className="text-sm text-slate-600 dark:text-slate-300">{msg}</p>
      {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  )
}

export function Notice({ tone = 'amber', children }: { tone?: 'amber' | 'red' | 'blue' | 'green'; children: ReactNode }) {
  const t = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200',
    red: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200',
    blue: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-200',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200',
  }[tone]
  return <div className={cls('rounded-xl border px-3.5 py-2.5 text-sm', t)}>{children}</div>
}

/* ─── Overlays ──────────────────────────────────────────────────────────── */

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
}

function useLockScroll(open: boolean) {
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])
}

export function Modal({ open, onClose, title, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg'
}) {
  useEscape(open, onClose)
  useLockScroll(open)
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])')?.focus()
  }, [open])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-slate-950/50 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cls(
          'relative flex max-h-[92dvh] w-full flex-col rounded-t-3xl bg-white shadow-2xl sm:rounded-2xl dark:bg-ink-900',
          { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-3xl' }[size],
        )}
      >
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5 dark:border-white/[0.07]">
          <h2 id={titleId} className="text-[15px] font-semibold">{title}</h2>
          <button data-close type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/5">
            <X className="size-5" />
          </button>
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 rounded-b-2xl border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-white/[0.07] dark:bg-ink-800/50">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

export function Drawer({ open, onClose, title, subtitle, children, footer, width = 'max-w-xl' }: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string
}) {
  useEscape(open, onClose)
  useLockScroll(open)
  const titleId = useId()
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-[1px]" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={cls('relative flex h-full w-full flex-col bg-white shadow-2xl dark:bg-ink-900', width)}>
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-3.5 dark:border-white/[0.07] dark:bg-ink-800/40">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-lg font-semibold">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-slate-500">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/5">
            <X className="size-5" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-slate-200 bg-slate-50/70 px-5 py-3 dark:border-white/[0.07] dark:bg-ink-800/40">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  )
}

export function Tabs<T extends string>({ value, onChange, tabs }: {
  value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; hidden?: boolean }[]
}) {
  return (
    <div role="tablist" className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto border-b border-slate-200 px-1 dark:border-white/10">
      {tabs.filter((t) => !t.hidden).map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cls(
            '-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition',
            value === t.value
              ? 'border-brand-600 font-semibold text-brand-700 dark:border-brand-400 dark:text-brand-300'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

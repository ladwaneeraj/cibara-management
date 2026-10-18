import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from 'lucide-react'
import { cls } from '@/lib/format'
import type { Finding } from '../types'

interface Look { Icon: LucideIcon; box: string; icon: string }

const LOOKS: Record<'good' | 'warn' | 'bad' | 'info', Look> = {
  good: { Icon: CheckCircle2, box: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-100', icon: 'text-emerald-600 dark:text-emerald-300' },
  warn: { Icon: AlertTriangle, box: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100', icon: 'text-amber-600 dark:text-amber-300' },
  bad: { Icon: XCircle, box: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-100', icon: 'text-rose-600 dark:text-rose-300' },
  info: { Icon: Info, box: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-100', icon: 'text-sky-600 dark:text-sky-300' },
}

function lookFor(level: string): Look {
  const l = level.toLowerCase()
  if (l === 'good' || l === 'success' || l === 'positive') return LOOKS.good
  if (l === 'warn' || l === 'warning' || l === 'caution') return LOOKS.warn
  if (l === 'bad' || l === 'danger' || l === 'critical' || l === 'error') return LOOKS.bad
  return LOOKS.info
}

/** The server's plain-language rules ("what to look at"). Nothing to say → nothing rendered. */
export function Findings({ items }: { items: Finding[] }) {
  if (items.length === 0) return null
  return (
    <section aria-labelledby="sec-findings" className="space-y-2">
      <h2 id="sec-findings" className="text-[13px] font-semibold tracking-tight text-slate-800 dark:text-slate-100">What to look at</h2>
      <ul className="grid gap-2 md:grid-cols-2">
        {items.map((f, i) => {
          const { Icon, box, icon } = lookFor(String(f.level))
          return (
            <li key={`${i}-${f.text}`} className={cls('flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm', box)}>
              <Icon className={cls('mt-0.5 size-4 shrink-0', icon)} aria-hidden />
              <span>{f.text}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

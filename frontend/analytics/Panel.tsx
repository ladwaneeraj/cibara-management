import type { ReactNode } from 'react'
import { Card } from '@/components/ui'

/** A titled card whose heading is an <h3> (subordinate to a section's <h2>), so
 *  chart panels don't read as top-level sections. Shared by the sections. */
export function ChartCard({ title, action, className, children }: {
  title: string; action?: ReactNode; className?: string; children: ReactNode
}) {
  return (
    <Card className={className} padded={false}>
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5 sm:px-5 dark:border-white/[0.07]">
        <h3 className="text-[13px] font-semibold tracking-tight text-slate-800 dark:text-slate-100">{title}</h3>
        {action}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </Card>
  )
}

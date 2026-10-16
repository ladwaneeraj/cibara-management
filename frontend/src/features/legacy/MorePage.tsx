import { BookOpenCheck, CalendarRange, ClipboardList, ExternalLink, Shirt, UsersRound, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import { PageHeader } from '@/components/layout/AppShell'
import { Card } from '@/components/ui'

const MODULES: { title: string; desc: string; icon: ReactNode }[] = [
  { title: 'Bookings & calendar', desc: 'Advance bookings, MMT / Agoda, availability calendar, booking check-in', icon: <CalendarRange className="size-5" /> },
  { title: 'Register', desc: 'Daily guest register, serial numbers, stay-time and payment corrections', icon: <BookOpenCheck className="size-5" /> },
  { title: 'Staff & payroll', desc: 'Attendance, advances, salaries, meals', icon: <UsersRound className="size-5" /> },
  { title: 'Laundry', desc: 'Send / receive, monthly bills, ledger', icon: <Shirt className="size-5" /> },
  { title: 'Maintenance', desc: 'Deep-check rounds, issues, checklist', icon: <Wrench className="size-5" /> },
  { title: 'Expense entry with OCR', desc: 'Invoice scan, staff advances, split payments, GST purchase bills', icon: <ClipboardList className="size-5" /> },
]

export function MorePage() {
  return (
    <div>
      <PageHeader title="More modules" subtitle="These run on the classic screens while they are migrated. Same login, same data." />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {MODULES.map((m) => (
          <a key={m.title} href="/legacy" className="group">
            <Card className="h-full transition group-hover:-translate-y-0.5 group-hover:shadow-md">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">{m.icon}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-semibold">{m.title}<ExternalLink className="size-3.5 text-slate-400" /></div>
                  <p className="mt-0.5 text-sm text-slate-500">{m.desc}</p>
                </div>
              </div>
            </Card>
          </a>
        ))}
      </div>
    </div>
  )
}

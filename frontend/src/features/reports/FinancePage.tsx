import { useState } from 'react'
import { PageHeader } from '@/components/layout/AppShell'
import { Input, Select, Tabs } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { addDays, istDate, monthStart } from '@/lib/format'
import { Expenses } from './Expenses'
import { GstReport } from './GstReport'
import { Operations } from './Operations'
import { Overview } from './Overview'
import { Settlements } from './Settlements'
import { Transactions } from './Transactions'

type Tab = 'overview' | 'gst' | 'ops' | 'txn' | 'settle' | 'exp'
type Preset = 'today' | '7d' | 'month' | 'lastmonth' | '3d' | 'custom'

export type Range = { start: string; end: string }

function range(p: Preset, custom: Range): Range {
  const t = istDate()
  switch (p) {
    case 'today': return { start: t, end: t }
    case '3d': return { start: addDays(t, -2), end: t }
    case '7d': return { start: addDays(t, -6), end: t }
    case 'month': return { start: monthStart(t), end: t }
    case 'lastmonth': {
      const firstThis = monthStart(t)
      const lastPrev = addDays(firstThis, -1)
      return { start: monthStart(lastPrev), end: lastPrev }
    }
    default: return custom
  }
}

export function FinancePage() {
  const can = useAuth((s) => s.can)
  useAuth((s) => s.permissions)
  const isAdmin = useAuth((s) => s.user?.role === 'admin')
  const tabs: { value: Tab; label: string; hidden?: boolean }[] = [
    { value: 'overview', label: 'Overview', hidden: !can('analytics.view') },
    { value: 'gst', label: 'GST (GSTR-1)', hidden: !can('analytics.view') },
    { value: 'ops', label: 'Operations', hidden: !can('analytics.view') },
    { value: 'txn', label: 'Transactions', hidden: !can('register.view') },
    { value: 'settle', label: 'Settle later', hidden: !can('settlement.collect') },
    { value: 'exp', label: 'Expenses', hidden: !can('expense.view') },
  ]
  const first = tabs.find((t) => !t.hidden)?.value ?? 'txn'
  const [tab, setTab] = useState<Tab>(first)
  const [preset, setPreset] = useState<Preset>(isAdmin ? 'month' : '3d')
  const [custom, setCustom] = useState<Range>({ start: addDays(istDate(), -6), end: istDate() })
  const r = range(preset, custom)
  const showRange = tab !== 'gst' && tab !== 'settle'

  return (
    <div>
      <PageHeader title={can('analytics.view') ? 'Reports' : 'Finance'}
        actions={showRange && (
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Period" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className="w-auto">
              <option value="today">Today</option>
              <option value="3d">Last 3 days</option>
              {isAdmin && <option value="7d">Last 7 days</option>}
              {isAdmin && <option value="month">This month</option>}
              {isAdmin && <option value="lastmonth">Last month</option>}
              {(isAdmin || tab === 'exp') && <option value="custom">Custom…</option>}
            </Select>
            {preset === 'custom' && (
              <>
                <Input type="date" aria-label="From" value={custom.start} max={custom.end} onChange={(e) => setCustom({ ...custom, start: e.target.value })} className="w-auto" />
                <Input type="date" aria-label="To" value={custom.end} min={custom.start} max={istDate()} onChange={(e) => setCustom({ ...custom, end: e.target.value })} className="w-auto" />
              </>
            )}
          </div>
        )} />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      <div className="mt-4">
        {tab === 'overview' && <Overview range={r} />}
        {tab === 'gst' && <GstReport />}
        {tab === 'ops' && <Operations range={r} />}
        {tab === 'txn' && <Transactions range={r} />}
        {tab === 'settle' && <Settlements />}
        {tab === 'exp' && <Expenses range={r} />}
      </div>
    </div>
  )
}

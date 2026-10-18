import { Input, Segmented } from '@/components/ui'
import { istDate } from '@/lib/format'
import { rangeFor, type Preset, type Range } from './range'

const OPTIONS: { value: Preset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
  { value: 'custom', label: 'Custom' },
]

/** Presets + custom dates; drives the single overview query. */
export function RangePicker({ value, onChange, today = istDate() }: { value: Range; onChange: (r: Range) => void; today?: string }) {
  const pick = (p: Preset) => {
    if (p === 'custom') onChange({ preset: 'custom', from: value.from, to: value.to })
    else onChange(rangeFor(p, today))
  }
  // An inverted range is ignored; the controlled input snaps back.
  const setFrom = (from: string) => { if (from && from <= value.to) onChange({ preset: 'custom', from, to: value.to }) }
  const setTo = (to: string) => { if (to && to >= value.from) onChange({ preset: 'custom', from: value.from, to }) }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented size="sm" value={value.preset} onChange={pick} options={OPTIONS} className="max-w-full overflow-x-auto" />
      {value.preset === 'custom' && (
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            From
            <Input type="date" value={value.from} max={value.to} onChange={(e) => setFrom(e.target.value)} className="h-8 w-auto py-0 text-xs" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            To
            <Input type="date" value={value.to} min={value.from} max={today} onChange={(e) => setTo(e.target.value)} className="h-8 w-auto py-0 text-xs" />
          </label>
        </div>
      )}
    </div>
  )
}

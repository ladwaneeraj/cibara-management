import { addDays, monthStart } from '@/lib/format'

export type Preset = 'today' | '7d' | '30d' | 'month' | 'custom'
export interface Range { preset: Preset; from: string; to: string }

/** A preset resolved against an IST business day ("YYYY-MM-DD"). */
export function rangeFor(preset: Exclude<Preset, 'custom'>, today: string): Range {
  switch (preset) {
    case 'today': return { preset, from: today, to: today }
    case '7d': return { preset, from: addDays(today, -6), to: today }
    case '30d': return { preset, from: addDays(today, -29), to: today }
    case 'month': return { preset, from: monthStart(today), to: today }
  }
}

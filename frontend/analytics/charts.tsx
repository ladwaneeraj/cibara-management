/**
 * Chart primitives shared by the analytics sections. Same look as
 * features/reports/charts (PALETTE, muted axes, no animation) so the page reads
 * as part of the app; only the shapes this page needs are added here.
 */
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { PALETTE, compactInr } from '@/features/reports/charts'

export { PALETTE, compactInr }
export { Donut } from '@/features/reports/charts'

export const AXIS = { fontSize: 11, fill: '#94a3b8' }
export const GRID = 'rgba(148,163,184,.18)'
export const TIP_STYLE = { borderRadius: 12, border: '1px solid rgba(148,163,184,.25)', fontSize: 12 }

/** Stable colour per name so a channel keeps its colour across charts. */
export const colorAt = (i: number) => PALETTE[i % PALETTE.length]

export interface Datum { name: string; [series: string]: string | number | null }

/** Simple (optionally per-bar-coloured) vertical bar chart. */
export function Columns({ data, dataKey, name, format = (v: number) => String(v), height = 220, color = PALETTE[0], colorEach = false }: {
  data: Datum[]; dataKey: string; name: string; format?: (v: number) => string; height?: number; color?: string; colorEach?: boolean
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="name" tick={AXIS} tickLine={false} axisLine={false} interval={0} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => format(v)} allowDecimals={false} />
        <Tooltip contentStyle={TIP_STYLE} formatter={(v: number) => [format(v), name]} cursor={{ fill: 'rgba(148,163,184,.12)' }} />
        <Bar dataKey={dataKey} name={name} fill={color} radius={[3, 3, 0, 0]} maxBarSize={44} isAnimationActive={false}>
          {colorEach && data.map((_, i) => <Cell key={i} fill={colorAt(i)} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/** One or more lines over a shared category axis (months). */
export function Lines({ data, series, height = 220, yFormat = (v: number) => String(v), tipFormat }: {
  data: Datum[]; series: { key: string; name: string; color?: string }[]; height?: number
  yFormat?: (v: number) => string; tipFormat?: (v: number, name: string) => string
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="name" tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => yFormat(v)} />
        <Tooltip contentStyle={TIP_STYLE} formatter={(v: number, n: string) => [(tipFormat ?? yFormat)(v, n), n]} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {series.map((s, i) => (
          <Line key={s.key} dataKey={s.key} name={s.name} stroke={s.color ?? colorAt(i)} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

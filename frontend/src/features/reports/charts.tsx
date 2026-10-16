import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { money } from '@/lib/format'

const AXIS = { fontSize: 11, fill: '#94a3b8' }
const GRID = 'rgba(148,163,184,.18)'
export const PALETTE = ['#2449d8', '#f9a825', '#0d9488', '#64748b', '#7c3aed', '#e8890b', '#0284c7', '#e11d48', '#94a3b8']

/** ₹ axis ticks that stay readable for small and large values. */
export function compactInr(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e7) return `₹${(v / 1e7).toFixed(1)}Cr`
  if (a >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`
  if (a >= 1e3) return `₹${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`
  return `₹${Math.round(v)}`
}

const tip = {
  contentStyle: { borderRadius: 12, border: '1px solid rgba(148,163,184,.25)', fontSize: 12 },
  formatter: (v: number) => money(v),
}

export function StackedDaily({ data }: { data: { day: string; cash: number; online: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="day" tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={compactInr} />
        <Tooltip {...tip} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="cash" name="Cash" stackId="a" fill="#0d9488" maxBarSize={48} isAnimationActive={false} />
        <Bar dataKey="online" name="Online" stackId="a" fill="#2449d8" radius={[3, 3, 0, 0]} maxBarSize={48} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function Donut({ data, colors = PALETTE }: { data: { name: string; value: number }[]; colors?: string[] }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={62} outerRadius={92} paddingAngle={data.length > 1 ? 2 : 0} strokeWidth={0} isAnimationActive={false}>
          {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
        </Pie>
        <Tooltip {...tip} />
        <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v: string, e) => `${v} ${total ? Math.round(((e.payload as { value: number }).value / total) * 100) : 0}%`} />
      </PieChart>
    </ResponsiveContainer>
  )
}

export function HBar({ data, color = '#2449d8' }: { data: { name: string; value: number }[]; color?: string }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 30)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={compactInr} />
        <YAxis type="category" dataKey="name" tick={AXIS} tickLine={false} axisLine={false} width={84} />
        <Tooltip {...tip} />
        <Bar dataKey="value" fill={color} radius={[0, 3, 3, 0]} barSize={18} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function OpsTrend({ data }: { data: { day: string; cleanings: number; turnaround: number | null }[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ComposedChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="day" tick={AXIS} tickLine={false} axisLine={false} />
        <YAxis yAxisId="l" tick={AXIS} tickLine={false} axisLine={false} width={32} />
        <YAxis yAxisId="r" orientation="right" tick={AXIS} tickLine={false} axisLine={false} width={40} tickFormatter={(v) => `${v}m`} />
        <Tooltip contentStyle={tip.contentStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar yAxisId="l" dataKey="cleanings" name="Rooms cleaned" fill="#2449d8" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        <Line yAxisId="r" dataKey="turnaround" name="Avg turnaround (min)" stroke="#f9a825" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

/**
 * Guest demographics — age distribution, footfall by taluk, and a geographic
 * footfall map. Sourced from guest ID-document OCR (GET /customer_analytics),
 * all-time. Rendered as a BODY (no own section/heading) so it sits inside the
 * merged "Guests" section next to the CRM insights.
 */
import { Users } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { EmptyState, StatCard } from '@/components/ui'
import { count } from '@/lib/format'
import { AXIS, CASH_COLOR, GRID, NEUTRAL, TIP_STYLE } from '../charts'
import { ChartCard } from '../Panel'
import { GeoHeat } from '../GeoHeat'
import type { Demographics as Demo } from '../types'

function topByPlace(points: Demo['geo_points'], n = 8) {
  const m = new Map<string, number>()
  for (const p of points) {
    const k = (p.place || '').trim()
    if (!k) continue
    m.set(k, (m.get(k) ?? 0) + (p.guests || 0))
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, guests]) => ({ name, guests }))
}

export function DemographicsBody({ data }: { data?: Demo }) {
  const hasAny = !!data && (data.totals?.with_demographics ?? 0) > 0

  const ageData = (data?.age.buckets ?? []).map((b) => ({ name: b.label, count: b.count }))
  const ageMax = Math.max(0, ...ageData.map((a) => a.count))
  const byTaluk = topByPlace(data?.geo_points ?? [])
  const geo = data?.geo_points ?? []

  if (!hasAny) {
    return (
      <ChartCard title="Guest demographics">
        <EmptyState
          icon={<Users className="size-6" />}
          title="No demographic data yet"
          hint={data?.ocr_enabled === false
            ? 'Document OCR is off, so age and location are not extracted.'
            : `${data?.totals?.customers_scanned ?? 0} guests scanned · none with age/pincode captured yet.`}
        />
      </ChartCard>
    )
  }

  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Guests profiled" tone="brand" value={count(data?.totals.with_demographics)} hint="with age or pincode" />
        <StatCard label="Average age" tone="violet" value={data?.age.average != null ? `${data.age.average} yrs` : '—'} />
        <StatCard label="On the map" tone="green" value={count(geo.length)} hint="located pincodes" />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ChartCard title="Age distribution">
          {ageMax > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={ageData} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="name" tick={AXIS} tickLine={false} axisLine={false} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
                <Tooltip contentStyle={TIP_STYLE} formatter={(v: number) => [count(v), 'Guests']} cursor={{ fill: 'rgba(148,163,184,.12)' }} />
                <Bar dataKey="count" name="Guests" fill={NEUTRAL} radius={[3, 3, 0, 0]} maxBarSize={48} animationDuration={800} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyState title="No ages captured" />}
        </ChartCard>

        <ChartCard title="Footfall by taluk">
          {byTaluk.length ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={byTaluk} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                <CartesianGrid stroke={GRID} horizontal={false} />
                <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={AXIS} tickLine={false} axisLine={false} width={96} />
                <Tooltip contentStyle={TIP_STYLE} formatter={(v: number) => [count(v), 'Guests']} cursor={{ fill: 'rgba(148,163,184,.12)' }} />
                <Bar dataKey="guests" name="Guests" fill={CASH_COLOR} radius={[0, 3, 3, 0]} maxBarSize={24} animationDuration={800} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyState title="No taluk/place names resolved" />}
        </ChartCard>
      </div>

      <ChartCard title="Guest footfall map">
        {geo.length ? <GeoHeat points={geo} /> : <EmptyState title="No located pincodes" hint="Pincodes could not be resolved to map coordinates." />}
      </ChartCard>
    </>
  )
}

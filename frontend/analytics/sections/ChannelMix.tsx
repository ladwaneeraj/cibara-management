import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, EmptyState } from '@/components/ui'
import { count, money } from '@/lib/format'
import { AXIS, Donut, GRID, PALETTE, TIP_STYLE, compactInr } from '../charts'
import { pct } from '../format'
import type { ChannelMix as ChannelMixData } from '../types'

const NET = PALETTE[0]
const COMMISSION = '#e11d48'

/** Net revenue vs. what each OTA keeps, side by side per channel. */
function NetVsCommission({ rows }: { rows: ChannelMixData['channels'] }) {
  const data = rows.map((r) => ({ name: r.channel, net: r.net, commission: r.commission }))
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 44)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={compactInr} />
        <YAxis type="category" dataKey="name" tick={AXIS} tickLine={false} axisLine={false} width={92} />
        <Tooltip contentStyle={TIP_STYLE} formatter={(v: number) => money(v)} cursor={{ fill: 'rgba(148,163,184,.12)' }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="net" name="Net revenue" stackId="a" fill={NET} barSize={18} isAnimationActive={false} />
        <Bar dataKey="commission" name="OTA commission" stackId="a" fill={COMMISSION} radius={[0, 3, 3, 0]} barSize={18} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Revenue by booking channel, net of OTA commission. */
export function ChannelMix({ data }: { data: ChannelMixData }) {
  const rows = data.channels
  return (
    <Card title="Channel mix" padded={false}>
      {rows.length === 0 ? (
        <EmptyState title="No stays in this window" hint="Channel revenue appears once guests have stayed in the selected dates." />
      ) : (
        <div className="space-y-4 p-4 sm:p-5">
          <div data-testid="channel-chart" className="grid gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Share of gross room revenue</p>
              <Donut data={rows.map((r) => ({ name: r.channel, value: r.gross }))} />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">What you keep vs. what the channel keeps</p>
              <NetVsCommission rows={rows} />
            </div>
          </div>
          <div className="-mx-4 overflow-x-auto sm:-mx-5">
            <table className="table-erp min-w-[640px]">
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <th scope="col" className="text-right">Gross</th>
                  <th scope="col" className="text-right">Commission</th>
                  <th scope="col" className="text-right">Net</th>
                  <th scope="col" className="text-right">Net ADR</th>
                  <th scope="col" className="text-right">Share</th>
                  <th scope="col" className="text-right">Room-nights</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.channel}>
                    <td className="font-medium text-slate-800 dark:text-slate-100">
                      <span aria-hidden className="mr-2 inline-block size-2 rounded-full align-middle" style={{ background: PALETTE[i % PALETTE.length] }} />
                      {r.channel}
                    </td>
                    <td className="num text-right">{money(r.gross)}</td>
                    <td className="num text-right text-rose-600 dark:text-rose-300">{r.commission ? money(r.commission) : '—'}</td>
                    <td className="num text-right font-semibold text-slate-900 dark:text-white">{money(r.net)}</td>
                    <td className="num text-right">{money(r.net_adr)}</td>
                    <td className="num text-right">{pct(r.share_pct)}</td>
                    <td className="num text-right">{count(r.room_nights)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className="px-3 py-2.5">Total</td>
                  <td className="num px-3 py-2.5 text-right">{money(data.total_gross)}</td>
                  <td className="num px-3 py-2.5 text-right text-rose-600 dark:text-rose-300">{money(data.total_gross - data.total_net)}</td>
                  <td className="num px-3 py-2.5 text-right">{money(data.total_net)}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </Card>
  )
}

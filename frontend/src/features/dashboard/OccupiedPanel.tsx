import {
  ArrowRightLeft, Bath, BadgePercent, Building2, CalendarClock, CircleDollarSign, LogOut, Plus, Snowflake,
  Sparkles, Undo2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, Field, Input, Modal, Notice, Segmented, Select, Spinner, Textarea, Toggle } from '@/components/ui'
import { useCan } from '@/lib/auth'
import { cls, money, stamp } from '@/lib/format'
import type { PaymentRow, Room } from '@/lib/types'
import { confirmDialog, toast } from '@/lib/ui'
import { useDashboard, useRoomAction, useStayHistory, useTariffs } from './hooks'
import { isPremium } from './roomState'

type Mode = 'cash' | 'online'

const QUICK_ADDONS = [
  { item: 'Water 2L', unit: 30, accom: false },
  { item: 'Water 1L', unit: 20, accom: false },
]

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="num text-right font-medium">{children}</span>
    </div>
  )
}

function History({ room }: { room: Room }) {
  const { data, isLoading } = useStayHistory(room)
  const rows = useMemo(() => {
    if (!data) return []
    const seen = new Set<string>()
    const all: (PaymentRow & { kind: string })[] = []
    const push = (list: PaymentRow[] | undefined, kind: string) => {
      for (const p of list || []) {
        const key = `${p.type}|${p.method}|${p.amount}|${p.date}|${p.time}|${p.item || ''}`
        if (seen.has(key)) continue
        seen.add(key)
        all.push({ ...p, kind })
      }
    }
    push(data.addons, 'addon'); push(data.renewals, 'renewal'); push(data.refunds, 'refund')
    push(data.cash, 'cash'); push(data.online, 'online'); push(data.shifts, 'shift')
    return all.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))
  }, [data])
  if (isLoading) return <div className="py-6 text-center"><Spinner /></div>
  if (!rows.length) return <p className="py-4 text-sm text-slate-500">No transactions yet.</p>
  const label = (p: PaymentRow & { kind: string }) =>
    p.kind === 'addon' ? `${p.item}${p.quantity && p.quantity > 1 ? ` × ${p.quantity}` : ''}`
      : p.kind === 'renewal' ? (p.note || 'Rent renewal')
        : p.kind === 'refund' ? 'Refund'
          : p.kind === 'shift' ? 'Room shift'
            : p.type === 'checkin' ? 'Paid at check-in' : 'Payment'
  return (
    <ul className="divide-y divide-slate-100 dark:divide-white/5">
      {rows.map((p, i) => (
        <li key={i} className={cls('flex items-center justify-between gap-3 py-2 text-sm', p.voided && 'opacity-50 line-through')}>
          <div className="min-w-0">
            <div className="truncate font-medium">{label(p)}</div>
            <div className="text-xs text-slate-500">{stamp(`${p.date} ${p.time}`)} · {p.method === 'balance' ? 'on bill' : p.method}</div>
          </div>
          <span className={cls('num font-semibold', p.kind === 'refund' ? 'text-rose-600' : p.method === 'balance' ? 'text-slate-700 dark:text-slate-300' : 'text-emerald-600')}>
            {p.kind === 'refund' ? '−' : ''}{money(p.amount)}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function OccupiedPanel({ room, onDone }: { room: Room; onDone: () => void }) {
  const g = room.guest!
  const navigate = useNavigate()
  const canPay = useCan('room.checkout')
  const canUpdate = useCan('room.update')
  const canDiscount = useCan('discount.apply')
  const canTransfer = useCan('room.transfer')
  const canSettleLater = useCan('settle_later.use')
  const canBills = useCan('register.view')
  const { data: dash } = useDashboard()
  const { data: tariffs } = useTariffs()

  const [payAmt, setPayAmt] = useState(String(Math.max(room.balance, 0) || ''))
  const [payMode, setPayMode] = useState<Mode>('cash')
  const [addon, setAddon] = useState<null | { item: string; unit: string; qty: number; accom: boolean; method: 'balance' | 'cash' | 'online'; day: string }>(null)
  const [discount, setDiscount] = useState<null | { amount: string; reason: string }>(null)
  const [transfer, setTransfer] = useState<null | { to: string; ac: boolean; todayDiff: boolean }>(null)
  const [checkout, setCheckout] = useState<null | { settleLater: boolean; notes: string; billing: 'stamp' | 'company' | 'personal' }>(null)

  const pay = useRoomAction<{ amount: number; mode: Mode }>((r) => `/api/v2/rooms/${r}/payment`)
  const refund = useRoomAction<{ amount: number; mode: Mode }>((r) => `/api/v2/rooms/${r}/refund`)
  const addOn = useRoomAction<object>((r) => `/api/v2/rooms/${r}/addons`)
  const renew = useRoomAction<{ renewal_count: number }>((r) => `/api/v2/rooms/${r}/renew`)
  const disc = useRoomAction<{ amount: number; reason: string }>((r) => `/api/v2/rooms/${r}/discount`)
  const hk = useRoomAction<{ room_clean?: boolean; bathroom_clean?: boolean }>((r) => `/api/v2/rooms/${r}/housekeeping`)
  const move = useRoomAction<object>((r) => `/api/v2/rooms/${r}/transfer`)
  const out = useRoomAction<object>((r) => `/api/v2/rooms/${r}/checkout`, { silent: true })

  const mmt = g.payment === 'ota'
  const bal = room.balance || 0
  const sc = room.service_cleaning || {}
  const vacantRooms = (dash?.rooms || []).filter((r) => r.status === 'vacant')
  const targetTariff = transfer?.to ? tariffs?.[transfer.to] : undefined
  const sameCategory = !!transfer?.to && targetTariff?.category === room.category

  const doPay = async () => {
    const amount = Number(payAmt)
    if (!(amount > 0)) return
    if (bal < 0) await refund.mutateAsync({ room: room.id, body: { amount, mode: payMode } })
    else await pay.mutateAsync({ room: room.id, body: { amount, mode: payMode } })
    setPayAmt('')
  }

  const doAddon = async () => {
    if (!addon) return
    const unit = Number(addon.unit)
    if (!addon.item.trim() || !(unit >= 0)) return
    await addOn.mutateAsync({
      room: room.id,
      body: {
        item: addon.item.trim(), unit_price: unit, quantity: addon.qty, payment_method: addon.method,
        accommodation_charge: addon.accom, ...(addon.day ? { applied_on_day: Number(addon.day) } : {}),
      },
    })
    setAddon(null)
  }

  const doRenew = async () => {
    const ok = await confirmDialog({ title: `Renew room ${room.id}?`, message: `Adds ${money(g.price)} (day ${(room.renewal_count || 0) + 2}) to the balance.`, confirmLabel: 'Renew' })
    if (ok) await renew.mutateAsync({ room: room.id, body: { renewal_count: (room.renewal_count || 0) + 1 } })
  }

  const doCheckout = async () => {
    if (!checkout) return
    const body: Record<string, unknown> = { settle_later: checkout.settleLater, settlement_notes: checkout.notes }
    if (checkout.billing === 'personal') body.gst_profile = 'personal'
    else if (checkout.billing === 'company' && room.gst_profile) body.gst_profile = room.gst_profile
    const res = await out.mutateAsync({ room: room.id, body })
    setCheckout(null)
    onDone()
    const billId = res.bill_id as string | undefined
    if (billId && res.has_bill && canBills) {
      const view = await confirmDialog({ title: 'Checked out', message: `${String(res.message || 'Checkout successful')}. Open the bill?`, confirmLabel: 'Open bill' })
      if (view) navigate(`/bills?open=${encodeURIComponent(billId)}`)
    } else {
      toast(String(res.message || 'Checkout successful'))
    }
  }

  const blockReason = bal < 0 ? `Refund ${money(-bal)} first.` : bal > 0 && !mmt && !checkout?.settleLater ? `Collect ${money(bal)} first${canSettleLater ? ', or tick “Settle later”' : ''}.` : null

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-white/10">
        <div className="flex items-start justify-between gap-3 border-l-[3px] border-brand-600 bg-brand-50/50 px-4 py-3 dark:border-brand-400 dark:bg-brand-500/[0.07]">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold text-slate-900 dark:text-white">{g.name}</div>
            <div className="num text-sm text-slate-500 dark:text-slate-400">{g.mobile} · {g.guests || 1} guest{(g.guests || 1) > 1 ? 's' : ''}</div>
          </div>
          <div className="flex flex-wrap justify-end gap-1">
            {mmt && <Badge tone="violet">MMT prepaid</Badge>}
            {g.isAC && isPremium(room.id) && <Badge tone="cyan"><Snowflake className="size-3" />AC</Badge>}
            {room.gst_profile?.gstin && <Badge tone="brand"><Building2 className="size-3" />B2B</Badge>}
          </div>
        </div>
        <dl className="grid grid-cols-3 divide-x divide-slate-200 border-t border-slate-200 text-sm dark:divide-white/10 dark:border-white/10">
          <div className="px-4 py-2.5"><dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Rate</dt><dd className="num mt-0.5 font-semibold">{money(g.price)}</dd></div>
          <div className="px-4 py-2.5"><dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Day</dt><dd className="num mt-0.5 font-semibold">{room._renewal.day}{room._renewal.due && <Badge tone="red" className="ml-1.5">due</Badge>}</dd></div>
          <div className={cls('px-4 py-2.5', bal > 0 && 'bg-rose-50/70 dark:bg-rose-500/[0.08]', bal < 0 && 'bg-emerald-50/70 dark:bg-emerald-500/[0.08]')}>
            <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{bal < 0 ? 'Credit' : 'Balance'}</dt>
            <dd className={cls('num mt-0.5 text-base font-bold', bal > 0 ? 'text-rose-700 dark:text-rose-300' : bal < 0 ? 'text-emerald-700 dark:text-emerald-300' : '')}>{money(Math.abs(bal))}</dd>
          </div>
        </dl>
        <div className="border-t border-slate-200 bg-slate-50/70 px-4 py-2 text-xs text-slate-500 dark:border-white/10 dark:bg-ink-800/40">Checked in {stamp(room.checkin_time)}{room._renewal.next_renewal ? ` · next rent ${stamp(room._renewal.next_renewal)}` : ''}</div>
      </div>

      {canPay && !mmt && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{bal < 0 ? 'Refund to guest' : 'Collect payment'}</h3>
          <div className="flex gap-2">
            <Input type="number" inputMode="numeric" min={1} aria-label="Amount" placeholder="Amount" value={payAmt}
              onChange={(e) => setPayAmt(e.target.value)} className="flex-1" />
            <Segmented<Mode> value={payMode} onChange={setPayMode} options={[{ value: 'cash', label: 'Cash' }, { value: 'online', label: 'UPI' }]} />
          </div>
          <Button className="w-full" variant={bal < 0 ? 'danger' : 'success'} loading={pay.isPending || refund.isPending}
            disabled={!(Number(payAmt) > 0) || (bal < 0 && Number(payAmt) > -bal)}
            icon={bal < 0 ? <Undo2 className="size-4" /> : <CircleDollarSign className="size-4" />} onClick={doPay}>
            {bal < 0 ? `Refund ${money(Number(payAmt) || 0)}` : `Receive ${money(Number(payAmt) || 0)}`}
          </Button>
        </section>
      )}
      {mmt && <Notice tone="blue">Prepaid through the OTA — no balance is collected at the desk.</Notice>}

      {canUpdate && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Add service</h3>
          <div className="flex flex-wrap gap-2">
            {QUICK_ADDONS.map((a) => (
              <Button key={a.item} size="sm" variant="subtle" icon={<Plus className="size-3.5" />}
                onClick={() => setAddon({ item: a.item, unit: String(a.unit), qty: 1, accom: a.accom, method: 'balance', day: '' })}>
                {a.item} · {money(a.unit)}
              </Button>
            ))}
            <Button size="sm" variant="subtle" icon={<Plus className="size-3.5" />} onClick={() => setAddon({ item: 'Extra Bed', unit: '', qty: 1, accom: true, method: 'balance', day: '' })}>Extra bed</Button>
            {isPremium(room.id) && !g.isAC && (
              <Button size="sm" variant="subtle" icon={<Snowflake className="size-3.5" />} onClick={() => setAddon({ item: 'AC', unit: String(tariffs?.[room.id]?.ac_surcharge ?? 600), qty: 1, accom: true, method: 'balance', day: '' })}>AC upgrade</Button>
            )}
            <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => setAddon({ item: '', unit: '', qty: 1, accom: false, method: 'balance', day: '' })}>Custom</Button>
          </div>
        </section>
      )}

      <section className="grid grid-cols-2 gap-2">
        {canUpdate && room._renewal.due && <Button variant="danger" icon={<CalendarClock className="size-4" />} loading={renew.isPending} onClick={doRenew}>Renew rent</Button>}
        {canDiscount && <Button variant="secondary" icon={<BadgePercent className="size-4" />} onClick={() => setDiscount({ amount: '', reason: 'Regular Customer' })}>Discount</Button>}
        {canTransfer && <Button variant="secondary" icon={<ArrowRightLeft className="size-4" />} onClick={() => setTransfer({ to: '', ac: false, todayDiff: true })}>Shift room</Button>}
        <Button variant={sc.room ? 'subtle' : 'secondary'} icon={<Sparkles className="size-4" />} loading={hk.isPending}
          onClick={() => hk.mutate({ room: room.id, body: { room_clean: !sc.room } })}>{sc.room ? 'Room cleaning ✓' : 'Request cleaning'}</Button>
        <Button variant={sc.bathroom ? 'subtle' : 'secondary'} icon={<Bath className="size-4" />} loading={hk.isPending}
          onClick={() => hk.mutate({ room: room.id, body: { bathroom_clean: !sc.bathroom } })}>{sc.bathroom ? 'Bathroom ✓' : 'Bathroom clean'}</Button>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-semibold">This stay</h3>
        <History room={room} />
      </section>

      {canPay && (
        <Button size="lg" className="w-full" icon={<LogOut className="size-4" />}
          onClick={() => setCheckout({ settleLater: false, notes: '', billing: 'stamp' })}>Check out</Button>
      )}

      {/* add-on dialog */}
      <Modal open={!!addon} onClose={() => setAddon(null)} title="Add service"
        footer={<><Button variant="secondary" onClick={() => setAddon(null)}>Cancel</Button><Button loading={addOn.isPending} onClick={doAddon}>Add {money(Number(addon?.unit || 0) * (addon?.qty || 1))}</Button></>}>
        {addon && (
          <div className="space-y-3">
            <Field label="Item"><Input value={addon.item} onChange={(e) => setAddon({ ...addon, item: e.target.value })} maxLength={80} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Unit price"><Input type="number" min={0} value={addon.unit} onChange={(e) => setAddon({ ...addon, unit: e.target.value })} /></Field>
              <Field label="Quantity"><Input type="number" min={1} max={100} value={addon.qty} onChange={(e) => setAddon({ ...addon, qty: Math.max(1, Number(e.target.value || 1)) })} /></Field>
            </div>
            <div>
              <span className="label">Paid by</span>
              <Segmented value={addon.method} onChange={(m) => setAddon({ ...addon, method: m })} className="w-full"
                options={[{ value: 'balance', label: 'Add to bill' }, { value: 'cash', label: 'Cash' }, { value: 'online', label: 'UPI' }]} />
            </div>
            <Toggle checked={addon.accom} onChange={(v) => setAddon({ ...addon, accom: v })} label="Accommodation charge (taxed with the room)" />
            {addon.accom && room._renewal.day > 1 && (
              <Field label="Apply to night" hint="Which night's GST slab this charge belongs to">
                <Select value={addon.day} onChange={(e) => setAddon({ ...addon, day: e.target.value })}>
                  <option value="">Current night (day {room._renewal.day})</option>
                  {Array.from({ length: room._renewal.day - 1 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>Day {d}</option>)}
                </Select>
              </Field>
            )}
          </div>
        )}
      </Modal>

      {/* discount dialog */}
      <Modal open={!!discount} onClose={() => setDiscount(null)} title="Apply discount" size="sm"
        footer={<><Button variant="secondary" onClick={() => setDiscount(null)}>Cancel</Button>
          <Button loading={disc.isPending} disabled={!(Number(discount?.amount) > 0)} onClick={async () => {
            await disc.mutateAsync({ room: room.id, body: { amount: Number(discount!.amount), reason: discount!.reason } }); setDiscount(null)
          }}>Apply</Button></>}>
        {discount && (
          <div className="space-y-3">
            <Field label="Amount"><Input type="number" min={1} value={discount.amount} onChange={(e) => setDiscount({ ...discount, amount: e.target.value })} /></Field>
            <Field label="Reason">
              <Select value={discount.reason} onChange={(e) => setDiscount({ ...discount, reason: e.target.value })}>
                {['Regular Customer', 'Special Offer', 'Long Stay', 'Complaint Resolution', 'Other'].map((r) => <option key={r}>{r}</option>)}
              </Select>
            </Field>
          </div>
        )}
      </Modal>

      {/* transfer dialog */}
      <Modal open={!!transfer} onClose={() => setTransfer(null)} title={`Shift guest from room ${room.id}`}
        footer={<><Button variant="secondary" onClick={() => setTransfer(null)}>Cancel</Button>
          <Button loading={move.isPending} disabled={!transfer?.to} onClick={async () => {
            await move.mutateAsync({ room: room.id, body: { new_room: transfer!.to, apply_today_diff: transfer!.todayDiff, ...(isPremium(transfer!.to) ? { is_ac: transfer!.ac } : {}) } })
            setTransfer(null); onDone()
          }}>Shift to {transfer?.to || '…'}</Button></>}>
        {transfer && (
          <div className="space-y-3">
            <Field label="New room">
              <Select value={transfer.to} onChange={(e) => setTransfer({ ...transfer, to: e.target.value })}>
                <option value="">Choose a vacant room</option>
                {vacantRooms.map((r) => <option key={r.id} value={r.id}>{r.id} · {r.category}</option>)}
              </Select>
            </Field>
            {transfer.to && (sameCategory || mmt
              ? <Notice tone="blue">Same category — the tariff stays {money(g.price)}.</Notice>
              : <Notice tone="amber">Different category — the server re-rates the stay to the standard {money(targetTariff?.prices[String(g.guests || 1)] ?? 0)}{transfer.ac && isPremium(transfer.to) ? ' + AC' : ''} per night from now. Needs “cross-category” permission.</Notice>)}
            {transfer.to && isPremium(transfer.to) && <Toggle checked={transfer.ac} onChange={(v) => setTransfer({ ...transfer, ac: v })} label="AC in the new room" />}
            {transfer.to && !sameCategory && !mmt && <Toggle checked={transfer.todayDiff} onChange={(v) => setTransfer({ ...transfer, todayDiff: v })} label="Charge today's rate difference" />}
          </div>
        )}
      </Modal>

      {/* checkout dialog */}
      <Modal open={!!checkout} onClose={() => setCheckout(null)} title={`Check out room ${room.id}`}
        footer={<><Button variant="secondary" onClick={() => setCheckout(null)}>Cancel</Button>
          <Button loading={out.isPending} disabled={!!blockReason} onClick={doCheckout}>Yes, check out</Button></>}>
        {checkout && (
          <div className="space-y-3">
            <Row label="Guest">{g.name}</Row>
            <Row label={bal < 0 ? 'Credit to refund' : 'Balance'}>{money(Math.abs(bal))}</Row>
            {blockReason && <Notice tone="amber">{blockReason}</Notice>}
            {canSettleLater && bal > 0 && !mmt && (
              <>
                <Toggle checked={checkout.settleLater} onChange={(v) => setCheckout({ ...checkout, settleLater: v })} label="Settle later (guest pays on a later visit)" />
                {checkout.settleLater && <Textarea placeholder="Notes for the settlement" value={checkout.notes} maxLength={500} onChange={(e) => setCheckout({ ...checkout, notes: e.target.value })} />}
              </>
            )}
            {room.gst_profile?.gstin && (
              <div>
                <span className="label">Bill to</span>
                <Segmented value={checkout.billing === 'stamp' ? 'company' : checkout.billing} onChange={(v) => setCheckout({ ...checkout, billing: v })} className="w-full"
                  options={[{ value: 'company', label: room.gst_profile.legal_name || 'Company' }, { value: 'personal', label: 'Personal' }]} />
              </div>
            )}
            <p className="text-xs text-slate-500">The bill and its GST are calculated by the server exactly as before; whether a numbered invoice is issued follows the billing settings.</p>
          </div>
        )}
      </Modal>
    </div>
  )
}

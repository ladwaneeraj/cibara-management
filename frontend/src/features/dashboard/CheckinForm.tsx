import { AlertTriangle, Building2, Clock, ReceiptText, User } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button, Field, Input, Notice, Segmented, Toggle } from '@/components/ui'
import { money, shortDate } from '@/lib/format'
import type { Room } from '@/lib/types'
import { useCustomer, useCustomerSuggest, useRoomAction, useTariffs } from './hooks'
import { isPremium } from './roomState'

type Pay = 'cash' | 'online' | 'balance'

interface CheckinBody {
  name: string; mobile: string; guests: number; price: number; amount_paid: number; payment: Pay
  is_ac: boolean; checkin_time?: string | null; gst_profile?: unknown
}

function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
}

export function CheckinForm({ room, onDone }: { room: Room; onDone: () => void }) {
  const { data: tariffs } = useTariffs()
  const tariff = tariffs?.[room.id]
  const premium = isPremium(room.id)

  const [mobile, setMobile] = useState('')
  const [name, setName] = useState('')
  const [guests, setGuests] = useState<number>(tariff?.default_guests ?? 1)
  const [ac, setAc] = useState(false)
  const [price, setPrice] = useState<string>('')
  const [priceEdited, setPriceEdited] = useState(false)
  const [paid, setPaid] = useState<string>('')
  const [paidEdited, setPaidEdited] = useState(false)
  const [payment, setPayment] = useState<Pay>('cash')
  const [company, setCompany] = useState(false)
  const [time, setTime] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const { data: customer } = useCustomer(mobile)
  const { data: suggestions } = useCustomerSuggest(mobile.length >= 4 && mobile.length < 10 ? mobile : '')

  useEffect(() => { if (tariff) setGuests(tariff.default_guests) }, [tariff])

  const standard = useMemo(() => {
    if (!tariff) return null
    const base = tariff.prices[String(Math.min(Math.max(guests, 1), 6))] ?? tariff.prices['1']
    return base + (premium && ac ? tariff.ac_surcharge : 0)
  }, [tariff, guests, ac, premium])

  useEffect(() => { if (!priceEdited && standard != null) setPrice(String(standard)) }, [standard, priceEdited])
  useEffect(() => {
    if (payment === 'balance') setPaid('0')
    else if (!paidEdited) setPaid(price)
  }, [price, payment, paidEdited])
  useEffect(() => { if (customer?.name && !name) setName(customer.name) }, [customer, name])

  const checkin = useRoomAction<CheckinBody>((r) => `/api/v2/rooms/${r}/checkin`)

  const priceN = Number(price || 0)
  const paidN = Number(paid || 0)
  const balance = priceN - paidN

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr(null)
    if (!/^\d{10}$/.test(mobile)) return setErr('Enter a 10-digit mobile number.')
    if (!name.trim()) return setErr('Enter the guest name.')
    if (!(priceN >= 1)) return setErr('Enter the room price.')
    if (payment === 'balance' && paidN > 0) return setErr("Cannot use 'Pay later' with an amount paid.")
    let checkinTime: string | null = null
    if (time) {
      checkinTime = `${todayIst()} ${time}`
    }
    try {
      await checkin.mutateAsync({
        room: room.id,
        body: {
          name: name.trim(), mobile, guests, price: priceN, amount_paid: paidN, payment, is_ac: premium && ac,
          checkin_time: checkinTime, gst_profile: company && customer?.gst_profile ? customer.gst_profile : null,
        },
      })
      onDone()
    } catch {
      /* toast shown by the hook */
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Mobile" htmlFor="ci-mobile">
        <div className="relative">
          <Input id="ci-mobile" inputMode="numeric" autoComplete="off" placeholder="10-digit mobile" maxLength={10}
            value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} />
          {suggestions && suggestions.length > 0 && mobile.length < 10 && (
            <ul className="card absolute z-10 mt-1 w-full overflow-hidden p-1 shadow-lg" role="listbox">
              {suggestions.map((c) => (
                <li key={c.mobile}>
                  <button type="button" onClick={() => { setMobile(c.mobile); setName(c.name) }}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-white/5">
                    <span className="flex items-center gap-2"><User className="size-4 text-slate-400" />{c.name}</span>
                    <span className="num text-slate-500">{c.mobile}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Field>

      {customer && (
        <div className="space-y-2">
          <div className="text-xs text-slate-500">Returning guest · {customer.total_stays ?? 0} stays{customer.last_stay_date ? ` · last ${shortDate(customer.last_stay_date)}` : ''}</div>
          {customer.is_flagged && (
            <Notice tone="red"><span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" />Flagged: {customer.flag_reason || customer.flag_notes || 'see customer notes'}</span></Notice>
          )}
          {customer.has_pending_settlement && (
            <Notice tone="amber">This guest owes {money(customer.pending_settlement_amount)} from a previous stay. Collect it from Finance → Settle later.</Notice>
          )}
          {customer.wants_bill && <Notice tone="blue"><span className="flex items-center gap-2"><ReceiptText className="size-4" />Guest always wants a GST bill.</span></Notice>}
        </div>
      )}

      <Field label="Guest name" htmlFor="ci-name">
        <Input id="ci-name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Guests" htmlFor="ci-guests">
          <Input id="ci-guests" type="number" min={1} max={20} value={guests} onChange={(e) => setGuests(Math.max(1, Number(e.target.value || 1)))} />
        </Field>
        <Field label="Price / night" htmlFor="ci-price" hint={standard != null && priceN !== standard ? `Standard ${money(standard)}` : undefined}>
          <Input id="ci-price" type="number" inputMode="numeric" min={1} value={price} onChange={(e) => { setPrice(e.target.value); setPriceEdited(true) }} />
        </Field>
      </div>

      {premium && <Toggle checked={ac} onChange={setAc} label={`AC room (+${money(tariff?.ac_surcharge ?? 600)})`} />}

      <div>
        <span className="label">Payment</span>
        <Segmented<Pay> value={payment} onChange={setPayment} className="w-full"
          options={[{ value: 'cash', label: 'Cash' }, { value: 'online', label: 'Online / UPI' }, { value: 'balance', label: 'Pay later' }]} />
      </div>

      <Field label="Amount paid now" htmlFor="ci-paid">
        <Input id="ci-paid" type="number" inputMode="numeric" min={0} disabled={payment === 'balance'} value={paid}
          onChange={(e) => { setPaid(e.target.value); setPaidEdited(true) }} />
      </Field>

      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 text-sm dark:bg-white/5">
        <span className="text-slate-500">Balance after check-in</span>
        <span className={`num font-semibold ${balance > 0 ? 'text-rose-600' : balance < 0 ? 'text-emerald-600' : ''}`}>
          {balance < 0 ? `${money(-balance)} credit` : money(balance)}
        </span>
      </div>

      {customer?.gst_profile?.gstin && (
        <Toggle checked={company} onChange={setCompany}
          label={<span className="flex items-center gap-2"><Building2 className="size-4" />Bill to {customer.gst_profile.legal_name || customer.gst_profile.gstin}</span>} />
      )}

      <details className="rounded-xl border border-slate-200 px-4 py-2 text-sm dark:border-white/10">
        <summary className="flex cursor-pointer items-center gap-2 text-slate-600 dark:text-slate-300"><Clock className="size-4" />Earlier check-in time today</summary>
        <div className="py-3">
          <Input type="time" aria-label="Check-in time" value={time} onChange={(e) => setTime(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500">Leave empty to use the current time. Only today's earlier times are accepted.</p>
        </div>
      </details>

      {err && <p role="alert" className="text-sm text-rose-600">{err}</p>}
      <Button type="submit" size="lg" className="w-full" loading={checkin.isPending}>Check in to room {room.id}</Button>
    </form>
  )
}

import type { PaymentMethod } from '../types/booking'

const METHODS: { v: PaymentMethod; l: string }[] = [
  { v: 'cash', l: 'Cash' },
  { v: 'upi', l: 'UPI' },
  { v: 'card', l: 'Card' },
  { v: 'online', l: 'Online' },
]

export function PaymentMethodPicker({
  value,
  onChange,
  includeLater,
}: {
  value: PaymentMethod
  onChange: (v: PaymentMethod) => void
  includeLater?: boolean
}) {
  const methods = includeLater ? [...METHODS, { v: 'balance' as PaymentMethod, l: 'Pay Later' }] : METHODS
  return (
    <div className="bki-row bki-methods payment-options">
      {methods.map((m) => (
        <button
          key={m.v}
          type="button"
          className={`payment-btn ${value === m.v ? 'active' : ''}`}
          onClick={() => onChange(m.v)}
        >
          {m.l}
        </button>
      ))}
    </div>
  )
}

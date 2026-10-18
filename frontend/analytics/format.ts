/** Percent with at most one decimal and no trailing ".0": 62.5 → "62.5%", 100 → "100%". */
export function pct(v: number | null | undefined): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0%'
  return `${Number(n.toFixed(1))}%`
}

/** "+5.2" / "-3" / "0" — signed change, no unit. */
export function signed(v: number): string {
  const n = Number(Number(v).toFixed(1))
  return n > 0 ? `+${n}` : String(n)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-10" → "Oct '26" */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-')
  const i = Number(m) - 1
  return MONTHS[i] ? `${MONTHS[i]} '${(y ?? '').slice(2)}` : ym
}

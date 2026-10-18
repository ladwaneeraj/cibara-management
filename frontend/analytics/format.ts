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

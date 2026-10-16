const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const num = new Intl.NumberFormat('en-IN')

export const money = (v: number | null | undefined) => inr.format(Number(v || 0))
export const money2 = (v: number | null | undefined) => inr2.format(Number(v || 0))
export const count = (v: number | null | undefined) => num.format(Number(v || 0))

/** "YYYY-MM-DD" in Asia/Kolkata — the business day used everywhere server-side. */
export function istDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d)
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return dt.toISOString().slice(0, 10)
}

export function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`
}

/** "2026-10-06 14:05" → "6 Oct, 2:05 pm" */
export function stamp(ts?: string | null): string {
  if (!ts) return '—'
  const [d, t] = ts.split(' ')
  const [y, m, day] = d.split('-').map(Number)
  if (!y || !m || !day) return ts
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  let out = `${day} ${months[m - 1]}`
  if (t) {
    const [hh, mm] = t.split(':').map(Number)
    const h12 = ((hh + 11) % 12) + 1
    out += `, ${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`
  }
  return out
}

export function shortDate(ymd?: string | null): string {
  return ymd ? stamp(ymd.slice(0, 10)) : '—'
}

export function duration(minutes: number | null | undefined): string {
  if (minutes == null) return '—'
  const m = Math.abs(Math.round(minutes))
  const h = Math.floor(m / 60)
  const r = m % 60
  return h ? `${h}h ${r}m` : `${r}m`
}

export function initials(name?: string | null): string {
  if (!name) return '?'
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('')
}

export function cls(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(' ')
}

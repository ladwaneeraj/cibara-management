import type { Booking } from '../types/booking'
import { bookingBalance } from './booking'

const COLUMNS: { header: string; value: (b: Booking) => string | number }[] = [
  { header: 'Booking ID', value: (b) => b.booking_id },
  { header: 'Room', value: (b) => b.room },
  { header: 'Guest', value: (b) => b.guest_name },
  { header: 'Mobile', value: (b) => b.guest_mobile },
  { header: 'Check-in', value: (b) => b.check_in_date },
  { header: 'Check-in time', value: (b) => b.check_in_time ?? '' },
  { header: 'Check-out', value: (b) => b.check_out_date },
  { header: 'Status', value: (b) => b.status },
  { header: 'Source', value: (b) => b.booking_source },
  { header: 'Total', value: (b) => b.total_amount },
  { header: 'Paid', value: (b) => b.paid_amount },
  { header: 'Balance', value: (b) => bookingBalance(b) },
]

function csvCell(v: string | number): string {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// CSV (Excel-openable) of the given bookings. Header + one row each.
export function exportCsv(bookings: Booking[]): string {
  const header = COLUMNS.map((c) => c.header).join(',')
  const rows = bookings.map((b) => COLUMNS.map((c) => csvCell(c.value(b))).join(','))
  return [header, ...rows].join('\n') + '\n'
}

// Trigger a browser download of the CSV (no-op-safe outside a DOM).
export function downloadCsv(bookings: Booking[], filename = 'bookings.csv'): void {
  const blob = new Blob([exportCsv(bookings)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

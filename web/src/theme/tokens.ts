// TS mirror of the classic CSS custom properties (static/style.css :root) so
// island components can reference theme values in JS (chart colors, inline
// styles). CSS should prefer the live var(--token); these are the same values
// for the cases where a JS value is needed. Foundation for later island tabs.
import type { BookingStatus } from '../types/booking'

export const tokens = {
  primary: '#4361ee',
  secondary: '#3f37c9',
  success: '#2ec4b6',
  danger: '#e63946',
  warning: '#ff9f1c',
  light: '#f8f9fa',
  dark: '#212529',
  gray: '#6c757d',
  bg: '#f5f7fb',
  surface: '#ffffff',
  border: '#e2e8f0',
  textPrimary: '#1f2937',
  textSecondary: '#64748b',
  radius: '8px',
  radiusLg: '12px',
  shadowSm: '0 2px 4px rgba(0, 0, 0, 0.05)',
  shadowMd: '0 5px 15px rgba(0, 0, 0, 0.1)',
  fontFamily: '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif',
} as const

// Booking status → accent color, drawn from the classic palette.
export const statusColor: Record<BookingStatus, string> = {
  confirmed: tokens.primary,
  checked_in: tokens.success,
  checked_out: tokens.gray,
  cancelled: tokens.danger,
  no_show: tokens.warning,
}

export const statusLabel: Record<BookingStatus, string> = {
  confirmed: 'Confirmed',
  checked_in: 'Checked In',
  checked_out: 'Checked Out',
  cancelled: 'Cancelled',
  no_show: 'No Show',
}

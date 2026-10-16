export interface Guest {
  name: string
  mobile: string
  price: number
  guests: number
  payment: string
  isAC?: boolean
  balance?: number
}

export interface Room {
  id: string
  status: 'vacant' | 'occupied' | 'cleaning'
  category: string
  guest: Guest | null
  checkin_time: string | null
  balance: number
  renewal_count?: number
  active_bill_id?: string | null
  cleaning_status?: 'in_progress' | 'ready_to_inspect' | null
  cleaning_start_time?: string | null
  service_cleaning?: { room?: boolean; bathroom?: boolean; requested_at?: string }
  last_bill_id?: string | null
  last_checkout_at?: string | null
  add_ons?: AddOn[]
  discounts?: { amount: number; reason: string; date: string; time: string }[]
  gst_profile?: GstProfile | null
  booking_source?: string
  stay_timeline?: { action: string; by: string; byName?: string; at: string }[]
  _renewal: { day: number; due: boolean; next_renewal: string | null; minutes_left: number | null }
  _mmt_prepaid: boolean
}

export interface AddOn {
  item: string
  price: number
  unit_price: number
  quantity: number
  payment_method: string
  date: string
  time: string
  voided?: boolean
  accommodation_charge?: boolean
}

export interface GstProfile {
  gstin: string
  legal_name?: string
  trade_name?: string
  address?: string
  state?: string
  state_code?: string
}

export interface Upcoming {
  booking_id: string
  guest_name: string
  check_in_date: string
  check_in_time?: string
  hours_until: number
  status: string
}

export interface Stats {
  vacant: number
  occupied: number
  cleaning: number
  balances_total: number
  balances_count: number
  renewals_due: number
  total: number
}

export interface TodaySummary {
  cash: number
  online: number
  refunds: number
  expenses: number
  net: number
  checkins: number
  transactions: number
}

export interface Dashboard {
  success: boolean
  server_time: string
  today: string
  rooms: Room[]
  stats: Stats
  upcoming: Record<string, Upcoming>
  ui_config: Record<string, boolean>
  totals?: Record<string, number>
  today_summary?: TodaySummary
}

export interface Tariff {
  category: string
  default_guests: number
  prices: Record<string, number>
  ac_surcharge: number
}

export interface Customer {
  name: string
  mobile: string
  total_stays?: number
  total_spent?: number
  last_stay_date?: string
  is_flagged?: boolean
  flag_reason?: string
  flag_notes?: string
  has_pending_settlement?: boolean
  pending_settlement_amount?: number
  pending_settlement_id?: string
  wants_bill?: boolean
  gst_profile?: GstProfile | null
}

export interface BillRow {
  id: string
  bill_number: string
  guest_name: string
  guest_mobile: string
  room: string
  checkin_time: string
  checkout_time: string
  days_stayed: number
  guest_count?: number
  total_amount: number
  payment_cash: number
  payment_online: number
  payment_ota: number
  refunds: number
  discounts: number
  balance: number
  status: string
  booking_source: string
  invoice_type: string
  recipient_gstin: string
  recipient_legal_name: string
  cancel_kind?: string | null
  cancel_reason?: string | null
  cancelled_by_name?: string | null
  superseded_by_revert: boolean
  is_cancellation_charge: boolean
  linked_credit_note_ids: string[]
  pdf_url: string
  activity: Record<string, { count: number; last_by?: string; last_at?: string }>
  gst: { tax: number; taxable: number; label: string }
}

export interface BillsPage {
  success: boolean
  bills: BillRow[]
  next_cursor: string | null
  range: { from: string; to: string }
}

export interface BillsSummary {
  cash: number
  online: number
  revenue: number
  invoices: number
  pending_count: number
  pending_amount: number
  gst: number
  gst_accommodation: number
  gst_services: number
  cancelled: number
  b2b: number
}

export interface PaymentRow {
  room: string
  name: string
  amount: number
  method: string
  type: string
  date: string
  time: string
  item?: string
  quantity?: number
  voided?: boolean
  note?: string
  transaction_type?: string
}

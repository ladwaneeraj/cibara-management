// Booking model. Shapes mirror the raw Firestore docs returned by
// routes/bookings.py (GET /get_bookings → {success, bookings:[...]}); optional
// fields reflect that legacy docs vary. No field is renamed from the backend.

export type BookingStatus =
  | 'confirmed'
  | 'checked_in'
  | 'checked_out'
  | 'cancelled'
  | 'no_show'

export type BookingSource = 'normal' | 'mmt' | 'agoda' | 'walk_in' | (string & {})

export type PaymentMethod =
  | 'cash'
  | 'upi'
  | 'card'
  | 'online'
  | 'balance'
  | 'ota'
  | 'already_paid'
  | 'bank_settlement'

export interface Booking {
  booking_id: string
  room: string
  guest_name: string
  guest_mobile: string
  check_in_date: string
  check_in_time?: string
  check_out_date: string
  status: BookingStatus
  booking_source: BookingSource
  guest_count?: number
  total_amount: number
  paid_amount: number
  balance: number
  is_ac?: boolean
  rate_per_night?: number | null
  notes?: string
  payment_method?: PaymentMethod
  group_booking_id?: string
  stay_id?: string
  // web-booking (Razorpay) fields, read-only to the island
  razorpay_order_id?: string
  receipt?: string
  created_at?: string
  // OTA fields
  settlement_status?: 'pending' | 'received'
  settlement_amount?: number | null
  net_receivable?: number
  ota_total_amount?: number
  ota_commission?: number
  // cancellation / no-show
  cancellation_reason?: string
  cancellation_date?: string
  no_show?: boolean
}

export interface CreateBookingPayload {
  room: string
  guest_name: string
  guest_mobile: string
  check_in_date: string
  check_in_time: string
  check_out_date: string
  total_amount: number
  paid_amount?: number
  payment_method?: PaymentMethod
  booking_source?: BookingSource
  is_ac?: boolean
  rate_per_night?: number | null
  guest_count?: number
  notes?: string
  photo_path?: string | null
  // OTA
  ota_total_amount?: number
  ota_commission?: number
  ota_commission_gst?: number
}

export interface MultiBookingRoom {
  room: string
  guest_name: string
  guest_mobile: string
  total_amount: number
  advance?: number
  guest_count?: number
  rate_per_night?: number | null
  is_ac?: boolean
}

export interface MultiBookingPayload {
  check_in_date: string
  check_in_time: string
  check_out_date: string
  booking_source?: BookingSource
  payment_method?: PaymentMethod
  notes?: string
  rooms: MultiBookingRoom[]
}

export interface UpdateBookingPayload {
  booking_id: string
  new_payment?: number
  payment_method?: PaymentMethod
  guest_name?: string
  guest_mobile?: string
  check_in_date?: string
  check_in_time?: string
  check_out_date?: string
  room?: string
  notes?: string
  guest_count?: number
  total_amount?: number
  status?: BookingStatus
  is_ac?: boolean
}

export interface CancelBookingPayload {
  booking_id: string
  refund_amount?: number
  refund_method?: PaymentMethod
  reason?: string
  retain_as_charge?: boolean
}

export interface ConvertCheckinPayload {
  booking_id: string
  remaining_payment?: number
  payment_method?: PaymentMethod
  room_price?: number
  is_ac?: boolean
}

export interface MarkOtaSettlementPayload {
  booking_id: string
  settlement_date: string
  settlement_amount: number
  utr?: string
}

export interface OtaSettlement {
  id: string
  booking_id: string
  platform: string
  room?: string
  guest_name?: string
  net_receivable?: number
  settlement_amount: number
  settlement_date: string
  utr?: string
}

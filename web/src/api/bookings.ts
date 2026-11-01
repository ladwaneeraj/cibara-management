// Typed functions for the unchanged Flask booking endpoints (routes/bookings.py).
// Every call goes through the apiFetch wrapper → window.apiFetch, so auth and
// the duplicate-submit protocol apply. No endpoint is renamed.
import { apiFetch } from './client'
import type {
  Booking,
  CancelBookingPayload,
  ConvertCheckinPayload,
  CreateBookingPayload,
  MarkOtaSettlementPayload,
  MultiBookingPayload,
  OtaSettlement,
  UpdateBookingPayload,
} from '../types/booking'

export async function getBookings(): Promise<Booking[]> {
  const r = await apiFetch<{ bookings: Booking[] }>('/get_bookings')
  return r.bookings ?? []
}

export async function getUpcomingList(): Promise<Booking[]> {
  const r = await apiFetch<{ bookings: Booking[] }>('/get_upcoming_bookings_list')
  return r.bookings ?? []
}

export async function checkAvailability(range: {
  check_in_date: string
  check_out_date: string
}): Promise<string[]> {
  const r = await apiFetch<{ available_rooms: string[] }>('/check_availability', {
    method: 'POST',
    json: range,
  })
  return r.available_rooms ?? []
}

export async function createBooking(payload: CreateBookingPayload): Promise<string> {
  const r = await apiFetch<{ booking_id: string }>('/create_booking', {
    method: 'POST',
    json: payload,
  })
  return r.booking_id
}

export async function createMultiBooking(
  payload: MultiBookingPayload,
): Promise<{ group_booking_id: string; booking_ids: string[] }> {
  return apiFetch('/create_multi_booking', { method: 'POST', json: payload })
}

export async function updateBooking(payload: UpdateBookingPayload): Promise<{ booking?: Booking }> {
  return apiFetch('/update_booking', { method: 'POST', json: payload })
}

export async function cancelBooking(
  payload: CancelBookingPayload,
): Promise<{ charge_bill_number?: string; charge_bill_id?: string; retained_amount?: number }> {
  return apiFetch('/cancel_booking', { method: 'POST', json: payload })
}

export async function convertToCheckin(
  payload: ConvertCheckinPayload,
): Promise<{ serial_number?: number; checkin_time?: string; arrival_status?: string }> {
  return apiFetch('/convert_booking_to_checkin', { method: 'POST', json: payload })
}

export async function sendConfirmation(payload: {
  booking_id: string
  phone_number: string
}): Promise<void> {
  await apiFetch('/send_booking_confirmation', { method: 'POST', json: payload })
}

export async function getOtaSettlements(): Promise<OtaSettlement[]> {
  const r = await apiFetch<{ settlements: OtaSettlement[] }>('/get_ota_settlements')
  return r.settlements ?? []
}

export async function getMmtUnsettled(): Promise<Booking[]> {
  const r = await apiFetch<{ unsettled: Booking[] }>('/get_mmt_unsettled')
  return r.unsettled ?? []
}

export async function markOtaSettlement(payload: MarkOtaSettlementPayload): Promise<void> {
  await apiFetch('/mark_ota_settlement', { method: 'POST', json: payload })
}

export async function fetchFromMmt(): Promise<void> {
  await apiFetch('/mmt/ingest', { method: 'POST' })
}

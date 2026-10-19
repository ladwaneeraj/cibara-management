import type { AnalyticsOverview, CustomerInsights, Demographics, FinancialsReport, Gstr1Summary } from '../types'

export const OVERVIEW: AnalyticsOverview = {
  success: true,
  window: { from: '2026-10-12', to: '2026-10-18', days: 7 },
  overview: {
    occupancy: {
      occupancy_pct: 62.5, adr: 2100, revpar: 1312.5, room_revenue: 183750,
      occupied_room_nights: 87, available_room_nights: 140, room_count: 20, nights_in_window: 7,
    },
    collections: { cash: 40000, online: 120000, refunds: 5000, net: 155000, net_revenue: 149000 },
    on_books_next7: { occupancy_pct: 48.2, on_books_revenue: 62400 },
  },
  channel_mix: {
    channels: [
      { channel: 'Direct/Walk-in', gross: 90000, commission: 0, net: 90000, net_adr: 2250, share_pct: 49, room_nights: 40 },
      { channel: 'MMT', gross: 60000, commission: 9000, net: 51000, net_adr: 1700, share_pct: 33, room_nights: 30 },
      { channel: 'Booking.com', gross: 33750, commission: 5062.5, net: 28687.5, net_adr: 1530, share_pct: 18, room_nights: 17 },
    ],
    total_gross: 183750,
    total_net: 169687.5,
  },
  pace: {
    horizons: {
      '7': { occupied_room_nights: 67, available_room_nights: 140, occupancy_pct: 47.9, on_books_revenue: 62400, delta: { occupancy_pct: 5.2, on_books_revenue: 8000 } },
      '14': { occupied_room_nights: 100, available_room_nights: 280, occupancy_pct: 35.7, on_books_revenue: 91000, delta: null },
      '30': { occupied_room_nights: 150, available_room_nights: 600, occupancy_pct: 25, on_books_revenue: 140000, delta: null },
    },
  },
  seasonality: {
    weekday: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((weekday, i) => ({
      weekday, occupancy_pct: 40 + i * 8, adr: 1800 + i * 50, revpar: 700 + i * 120,
    })),
    months: Array.from({ length: 12 }, (_, i) => ({
      month: `2026-${String(i + 1).padStart(2, '0')}`, occupancy_pct: 30 + i * 4, adr: 1900 + i * 20, revpar: 600 + i * 90,
    })),
  },
  los_leadtime: {
    los: [{ bucket: '1', count: 30 }, { bucket: '2', count: 22 }, { bucket: '3', count: 9 }, { bucket: '4-6', count: 4 }, { bucket: '7+', count: 1 }],
    lead_time: [{ bucket: 'walk-in', count: 25 }, { bucket: '0-1', count: 8 }, { bucket: '2-7', count: 18 }, { bucket: '8-30', count: 12 }, { bucket: '30+', count: 3 }],
  },
  findings: [
    { level: 'warn', icon: 'alert', text: 'MMT net ADR trails direct by 24%' },
    { level: 'good', icon: 'trend', text: 'Next 7 nights are 48% booked' },
  ],
  generated_at: '2026-10-18T10:00:00+00:00',
}

export const CUSTOMERS: CustomerInsights = {
  success: true,
  kpis: {
    total_customers: 1200, repeat_customers: 300, repeat_rate_pct: 25, total_revenue: 4800000, avg_spend: 4000,
    avg_stays: 1.6, active_90d: 210, new_30d: 44, dues_count: 6, dues_total: 18500,
    top10_revenue_share_pct: 38, top20_revenue_share_pct: 55,
  },
  segments: {
    loyalty: [{ label: 'New', count: 900 }, { label: 'Returning', count: 250 }, { label: 'Loyal', count: 50 }],
    value: [{ label: 'Under ₹5k', count: 800 }, { label: '₹5k–15k', count: 300 }, { label: '₹15k+', count: 100 }],
    recency: [{ label: 'Active', count: 210 }, { label: 'Cooling', count: 400 }, { label: 'Lost', count: 590 }],
  },
  acquisition_trend: Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(i + 1).padStart(2, '0')}`, count: 20 + i })),
  top_by_spend: [
    { name: 'Asha Rao', mobile: '9000000001', total_stays: 9, total_spent: 52000, last_stay_date: '2026-10-10', is_flagged: false },
    { name: 'Vikram Shah', mobile: '9000000002', total_stays: 4, total_spent: 31000, last_stay_date: '2026-09-01', is_flagged: false },
  ],
  top_by_stays: [
    { name: 'Meera Iyer', mobile: '9000000003', total_stays: 12, total_spent: 24000, last_stay_date: '2026-10-02', is_flagged: false },
  ],
  generated_at: '2026-10-18T10:00:00+00:00',
}

export const FINANCIALS: FinancialsReport = {
  success: true,
  cash_total: 12000, online_total: 8000, addon_total: 1500, refund_total: 200,
  expense_total: 500, transaction_expense_total: 500, report_expense_total: 0,
  total_revenue: 19300, checkins: 3, renewals: 12,
  cash_logs: [
    { date: '2026-10-14 10:00', amount: 7000, room: '201', method: 'cash' },
    { date: '2026-10-16 12:00', amount: 5000, room: '208', method: 'cash' },
  ],
  online_logs: [
    { date: '2026-10-14 11:00', amount: 5000, room: '201', method: 'online' },
    { date: '2026-10-17 09:00', amount: 3000, room: '210', method: 'online' },
  ],
  addon_logs: [{ date: '2026-10-15 13:00', amount: 1500, room: '201', type: 'addon' }],
  refund_logs: [{ date: '2026-10-16 14:00', amount: 200, room: '208', type: 'refund' }],
  renewal_logs: [],
  expense_logs: [{ date: '2026-10-15 18:00', amount: 500, type: 'expense' }],
}

export const DEMOGRAPHICS: Demographics = {
  success: true,
  age: {
    buckets: [
      { label: '<18', count: 0 }, { label: '18-25', count: 3 }, { label: '26-35', count: 8 },
      { label: '36-45', count: 4 }, { label: '46-55', count: 1 }, { label: '56-65', count: 0 }, { label: '65+', count: 0 },
    ],
    average: 31.2, count: 16,
  },
  pincodes: [{ pincode: '560001', guests: 6, visits: 9 }, { pincode: '580001', guests: 4, visits: 5 }],
  geo_points: [], // empty so the Leaflet map stays an empty-state in jsdom
  totals: { customers_scanned: 23, with_demographics: 16 },
  geo_available: true,
}

export const GSTR1: Gstr1Summary = {
  success: true,
  totals: { taxable: 23704.77, cgst: 592.61, sgst: 592.62, igst: 0, invoice_value: 36939, invoices: 20 },
  rate_summary: {
    '0': { taxable: 0, cgst: 0, sgst: 0, igst: 0 },
    '5': { taxable: 23704.77, cgst: 592.61, sgst: 592.62, igst: 0 },
  },
  b2b: [{}, {}, {}],
  b2cl: [],
  b2cs: [{ taxable: 276.19, cgst: 6.9, sgst: 6.91, igst: 0, count: 10, gst_rate: 0, place_of_supply: 'Karnataka (29)', state_code: '29', invoice_value: 10939 }],
  credit_notes: [],
  documents: 20,
}

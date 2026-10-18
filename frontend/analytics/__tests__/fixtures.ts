import type { AnalyticsOverview, CustomerInsights } from '../types'

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

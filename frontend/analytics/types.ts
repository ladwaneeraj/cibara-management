/**
 * Wire types for the analytics page.
 *
 * AnalyticsOverview mirrors GET /api/v2/analytics/overview
 * (services/register_analytics_service.compute_analytics_overview).
 * CustomerInsights mirrors GET /customer_insights
 * (services/customer_service.get_customer_insights).
 */

export interface AnalyticsWindow { from: string; to: string; days: number }

export interface OccupancyKpis {
  occupancy_pct: number
  adr: number
  revpar: number
  room_revenue: number
  occupied_room_nights: number
  available_room_nights: number
  room_count: number
  nights_in_window: number
}

export interface Collections {
  cash: number
  online: number
  refunds: number
  net: number
  net_revenue: number
}

export interface OnBooksNext7 { occupancy_pct: number; on_books_revenue: number }

export interface OverviewKpis {
  occupancy: OccupancyKpis
  collections: Collections
  on_books_next7: OnBooksNext7
}

export interface ChannelRow {
  channel: string
  gross: number
  commission: number
  net: number
  net_adr: number
  share_pct: number
  room_nights: number
}

export interface ChannelMix {
  channels: ChannelRow[]
  total_gross: number
  total_net: number
}

/** Change vs. the on-the-books snapshot ~7 days ago. The backend sends null
 *  until a comparable snapshot exists; we also tolerate a bare number
 *  (occupancy points) so a shape tweak cannot blank the card. */
export interface PaceDelta { occupancy_pct?: number | null; on_books_revenue?: number | null }

export interface PaceHorizon {
  occupied_room_nights: number
  available_room_nights: number
  occupancy_pct: number
  on_books_revenue: number
  delta: PaceDelta | number | null
}

export type PaceHorizonKey = '7' | '14' | '30'

export interface BookingPace { horizons: Partial<Record<PaceHorizonKey, PaceHorizon>> }

export interface SeasonPoint { occupancy_pct: number; adr: number; revpar: number }
export interface WeekdayPoint extends SeasonPoint { weekday: string }
export interface MonthPoint extends SeasonPoint { month: string }
export interface Seasonality { weekday: WeekdayPoint[]; months: MonthPoint[] }

export interface Bucket { bucket: string; count: number }
export interface LosLeadtime { los: Bucket[]; lead_time: Bucket[] }

export type FindingLevel = 'good' | 'warn' | 'bad' | 'info' | (string & {})
export interface Finding { level: FindingLevel; icon?: string; text: string }

export interface AnalyticsOverview {
  success: boolean
  window: AnalyticsWindow
  overview: OverviewKpis
  channel_mix: ChannelMix
  pace: BookingPace
  seasonality: Seasonality
  los_leadtime: LosLeadtime
  findings: Finding[]
  generated_at: string
}

/* ── Customers (reused /customer_insights) ─────────────────────────────── */

export interface CustomerKpis {
  total_customers: number
  repeat_customers: number
  repeat_rate_pct: number
  total_revenue: number
  avg_spend: number
  avg_stays: number
  active_90d: number
  new_30d: number
  new_this_month?: number
  flagged?: number
  wants_bill?: number
  gst_customers?: number
  dues_count: number
  dues_total: number
  top10_revenue_share_pct: number
  top20_revenue_share_pct: number
}

export interface SegmentBand { label: string; count: number }
export type SegmentDimension = 'loyalty' | 'value' | 'recency'

export interface CustomerRow {
  name: string
  mobile: string
  total_stays: number
  total_spent: number
  last_stay_date: string
  is_flagged: boolean
}

export interface CustomerInsights {
  success: boolean
  kpis: CustomerKpis
  segments: Record<SegmentDimension, SegmentBand[]>
  acquisition_trend: { month: string; count: number }[]
  top_by_spend: CustomerRow[]
  top_by_stays: CustomerRow[]
  generated_at: string
}

export interface CustomerSegment { success: boolean; customers: CustomerRow[]; count: number }

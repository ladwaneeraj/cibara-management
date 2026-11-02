// Website (online booking) config — mirrors the classic toggleOnlineBookings
// (static/script.js). GET is open; POST requires settings.update server-side.
// The guest website reads the public GET /web/config; this island writes the
// same flag through /settings/web_config.
import { apiFetch } from './client'

export interface WebConfig {
  online_bookings_enabled: boolean
}

function normalize(r: { config?: Partial<WebConfig> } | null): WebConfig {
  return { online_bookings_enabled: !!r?.config?.online_bookings_enabled }
}

export async function getWebConfig(): Promise<WebConfig> {
  return normalize(await apiFetch<{ config?: Partial<WebConfig> }>('/settings/web_config'))
}

export async function setOnlineBookings(enabled: boolean): Promise<WebConfig> {
  return normalize(
    await apiFetch<{ config?: Partial<WebConfig> }>('/settings/web_config', {
      method: 'POST',
      json: { online_bookings_enabled: enabled },
    }),
  )
}

// Toolbar control: accept/stop guest-website bookings. Visibility is gated on
// settings.update (what POST /settings/web_config enforces); the switch loads
// the current flag on mount and saves optimistically, reverting on error —
// the same contract as the classic Settings toggle (static/script.js).
import { useEffect, useState } from 'react'
import { getWebConfig, setOnlineBookings } from '../api/webConfig'
import { hasPerm } from '../lib/perm'

export function OnlineBookingsToggle() {
  const can = hasPerm('settings.update')
  const [enabled, setEnabled] = useState<boolean | null>(null) // null = loading
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!can) return
    let alive = true
    getWebConfig()
      .then((c) => alive && setEnabled(c.online_bookings_enabled))
      .catch(() => alive && setEnabled(false))
    return () => {
      alive = false
    }
  }, [can])

  if (!can) return null

  const on = enabled === true
  const busy = saving || enabled === null

  const toggle = async () => {
    if (busy) return
    const desired = !on
    setEnabled(desired) // optimistic
    setSaving(true)
    try {
      const c = await setOnlineBookings(desired)
      setEnabled(c.online_bookings_enabled)
    } catch {
      setEnabled(!desired) // revert
    } finally {
      setSaving(false)
    }
  }

  return (
    <label
      className={`bki-webtoggle ${on ? 'is-on' : ''} ${busy ? 'is-busy' : ''}`}
      title="Accept bookings from the guest website"
    >
      <i className="fas fa-globe" aria-hidden="true" />
      <span className="bki-webtoggle-text">
        Online bookings
        <small>{enabled === null ? 'Loading…' : on ? 'On · guests can book' : 'Off · closed'}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label="Online bookings"
        className="bki-webtoggle-input"
        checked={on}
        disabled={busy}
        onChange={toggle}
      />
      <span className="bki-webtoggle-track" aria-hidden="true">
        <span className="bki-webtoggle-knob" />
      </span>
    </label>
  )
}

"""
Permission gates for legacy routes that the Flask code leaves open.

The contract review found that several money/report routes require only a
login. A housekeeping account (or anyone holding any valid token) could call
them; only the old UI kept those roles away. The permission keys below already
exist in services/permissions.py and are already what the old UI checks before
showing the matching button, so legitimate users are unaffected:

  /checkin, /checkout        → room.checkin / room.checkout   (admin, manager)
  /checkout settle_later     → settle_later.use                (admin) — the UI
                               only offered it to admins; the server never checked
  /add_on, /renew_rent       → room.update                     (admin, manager)
  /reports, /revenue_report,
  /reports/gstr1_summary     → analytics.view                  (admin) — the
                               Reports tab is reachable only through Settings
  /render_bill_pdf           → register.view                   (admin, manager)
  /get_ota_settlements       → settlement.manage               (admin)

Business logic is untouched: a permitted request runs exactly as before.
Disable with LEGACY_RBAC_HARDENING=false if a hidden caller turns up.
"""
from __future__ import annotations

_GATES: dict[tuple[str, str], str] = {
    ("POST", "/checkin"): "room.checkin",
    ("POST", "/checkout"): "room.checkout",
    ("POST", "/add_on"): "room.update",
    ("POST", "/renew_rent"): "room.update",
    ("POST", "/reports"): "analytics.view",
    ("POST", "/revenue_report"): "analytics.view",
    ("POST", "/reports/gstr1_summary"): "analytics.view",
    ("POST", "/render_bill_pdf"): "register.view",
    ("GET", "/get_ota_settlements"): "settlement.manage",
}


def required_permission(method: str, path: str, body: dict | None) -> str | None:
    if method == "POST" and path == "/checkout" and isinstance(body, dict):
        if body.get("final_checkout") and body.get("settle_later"):
            return "settle_later.use"
    return _GATES.get((method.upper(), path))


def gated_routes() -> dict[tuple[str, str], str]:
    return dict(_GATES)

"""
/api/v2 reports, transactions, expenses and settle-later — typed facades.

Permission changes vs. the old API (logic unchanged):
  • /reports, /revenue_report, /reports/gstr1_summary were open to any login;
    here (and on the legacy paths, via the hardening hook) they need
    analytics.view — the old UI only ever showed them to admins.
  • transactions keep the legacy 3-day clamp for non-admins (applied inside
    the legacy route) and additionally require register.view, so the
    housekeeping role no longer receives revenue rows.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field, model_validator

from ..security.deps import Principal, get_principal, require_permission
from ._forward import forward

router = APIRouter(prefix="/api/v2", tags=["reports"])

def DateQ():
    return Query(pattern=r"^\d{4}-\d{2}-\d{2}$")
def DocId():
    return Path(pattern=r"^[A-Za-z0-9_-]{1,80}$")


def _check_range(start: str, end: str) -> None:
    if start > end:
        raise HTTPException(400, "start must be on or before end")


@router.get("/reports/summary")
async def report_summary(request: Request, start: str = DateQ(), end: str = DateQ(),
                         p: Principal = Depends(require_permission("analytics.view"))):
    _check_range(start, end)
    return await forward(p, request, "POST", "/reports", json={"start_date": start, "end_date": end})


@router.get("/reports/revenue")
async def report_revenue(request: Request, start: str = DateQ(), end: str = DateQ(),
                         p: Principal = Depends(require_permission("analytics.view"))):
    _check_range(start, end)
    return await forward(p, request, "POST", "/revenue_report", json={"start_date": start, "end_date": end})


@router.get("/reports/gstr1")
async def report_gstr1(request: Request,
                       month: Optional[str] = Query(default=None, pattern=r"^\d{4}-\d{2}$"),
                       start: Optional[str] = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                       end: Optional[str] = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                       p: Principal = Depends(require_permission("analytics.view"))):
    if month:
        body = {"month": month}
    elif start and end:
        _check_range(start, end)
        body = {"start_date": start, "end_date": end}
    else:
        raise HTTPException(400, "Provide month=YYYY-MM or start & end")
    return await forward(p, request, "POST", "/reports/gstr1_summary", json=body)


@router.get("/reports/insights")
async def report_insights(request: Request, start: str = DateQ(), end: str = DateQ(), fresh: bool = False,
                          p: Principal = Depends(require_permission("analytics.view"))):
    _check_range(start, end)
    return await forward(p, request, "GET", "/insights/summary",
                         query={"from": start, "to": end, "fresh": "1" if fresh else None})


@router.get("/reports/customers")
async def report_customers(request: Request, p: Principal = Depends(require_permission("customer.manage"))):
    return await forward(p, request, "GET", "/customer_analytics")


@router.get("/transactions")
async def transactions(request: Request, start: str = DateQ(), end: str = DateQ(),
                       p: Principal = Depends(require_permission("register.view"))):
    _check_range(start, end)
    return await forward(p, request, "POST", "/get_transactions_range", json={"from_date": start, "to_date": end})


# ── expenses ──────────────────────────────────────────────────────────────

@router.get("/expenses")
async def browse_expenses(request: Request, start: str = DateQ(), end: str = DateQ(),
                          p: Principal = Depends(require_permission("expense.view"))):
    _check_range(start, end)
    return await forward(p, request, "POST", "/expenses/browse", json={"start_date": start, "end_date": end})


ExpenseCategory = Literal["salary", "utilities", "petty_cash", "purchase", "maintenance", "sanitary",
                          "booking_commission", "marketing", "others", "rent"]


class SplitIn(BaseModel):
    counter_cash: int = Field(default=0, ge=0)
    home_cash: int = Field(default=0, ge=0)
    account: int = Field(default=0, ge=0)


class ExpenseIn(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    category: ExpenseCategory
    description: str = Field(min_length=1, max_length=300)
    amount: int = Field(gt=0, le=10_000_000)
    payment_method: Literal["cash", "online"] = "cash"
    type: Literal["transaction", "report"] = "transaction"
    split: Optional[SplitIn] = None
    paid_to: Optional[str] = Field(default=None, max_length=120)
    has_bill: Optional[bool] = None
    invoice_number: Optional[str] = Field(default=None, max_length=60)
    invoice_date: Optional[str] = Field(default=None, pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    has_gst: Optional[bool] = None
    vendor_name: Optional[str] = Field(default=None, max_length=200)
    vendor_gstin: Optional[str] = Field(default=None, max_length=15)
    taxable_amount: Optional[float] = Field(default=None, ge=0)
    gst_rate: Optional[float] = Field(default=None, ge=0, le=28)
    gst_amount: Optional[float] = Field(default=None, ge=0)
    invoice_photo_url: Optional[str] = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def _daily_is_cash(self):
        # Same rule as the expense modal: Daily (counter) expenses are cash.
        if self.type == "transaction" and self.split is None:
            self.payment_method = "cash"
        return self


@router.post("/expenses")
async def add_expense(body: ExpenseIn, request: Request,
                      p: Principal = Depends(require_permission("register.view"))):
    # Marketing (expense.marketing) and split (expense.manage) checks stay in
    # the legacy route; register.view only keeps housekeeping out.
    return await forward(p, request, "POST", "/add_expense", json=body.model_dump(exclude_none=True))


@router.delete("/expenses/{doc_id}")
async def delete_expense(request: Request, doc_id: str = DocId(),
                         p: Principal = Depends(require_permission("expense.manage"))):
    return await forward(p, request, "DELETE", f"/expense/{doc_id}")


@router.get("/expense-presets")
async def expense_presets(request: Request, p: Principal = Depends(get_principal)):
    return await forward(p, request, "GET", "/expense_presets")


# ── settle later ──────────────────────────────────────────────────────────

def _settlements(status: str) -> dict:
    """Settle-later list with a server-side status filter.

    The legacy route reads EVERY settlement ever written and looks up a bill
    for each one; the screen then hides all but pending/partial. Here the
    status filter runs in Firestore (single-field `in`/`==`, no composite
    index needed), and the unchanged legacy helper attaches the bill summary
    only for the rows returned. status=all keeps the legacy full read.
    Note: a settlement document with no `status` field at all can only be
    seen under "all" (Firestore cannot query a missing field); every
    settlement the app creates carries one.
    """
    from google.cloud.firestore_v1.base_query import FieldFilter
    from routes.settlements import _attach_bill_summary, fetch_settlements
    from ..legacy import legacy_config
    if status == "all":
        rows = fetch_settlements()
    else:
        wanted = {"open": ["pending", "partial"], "paid": ["paid"], "cancelled": ["cancelled"]}[status]
        q = legacy_config.settlements_ref.where(filter=FieldFilter("status", "in", wanted))
        rows = []
        for d in q.stream():
            row = d.to_dict() or {}
            row["id"] = d.id
            rows.append(row)
    rows = _attach_bill_summary(rows)
    rows.sort(key=lambda r: (r.get("checkout_date") or "", r.get("checkout_time") or ""), reverse=True)
    due = sum(int(r.get("amount") or 0) for r in rows if (r.get("status") or "pending") in ("pending", "partial"))
    return {"success": True, "settlements": rows, "count": len(rows), "total_due": due}


@router.get("/settlements")
async def settlements(status: Literal["open", "all", "paid", "cancelled"] = "open",
                      p: Principal = Depends(require_permission("settlement.collect"))):
    from starlette.concurrency import run_in_threadpool
    return await run_in_threadpool(_settlements, status)


class CollectIn(BaseModel):
    payment_mode: Literal["cash", "online"]
    payment_amount: int = Field(default=0, ge=0, le=10_000_000)
    payment_date: str = Field(default="", pattern=r"^(\d{4}-\d{2}-\d{2})?$")
    discount_amount: int = Field(default=0, ge=0, le=10_000_000)
    discount_reason: str = Field(default="", max_length=300)
    discount_type: Literal["financial", "credit_note"] = "financial"
    acknowledge_section34_window: bool = False


@router.post("/settlements/{settlement_id}/collect")
async def collect_settlement(body: CollectIn, request: Request, settlement_id: str = DocId(),
                             p: Principal = Depends(require_permission("settlement.collect"))):
    return await forward(p, request, "POST", "/collect_settlement",
                         json={"settlement_id": settlement_id, **body.model_dump()})


class CancelSettlementIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


@router.post("/settlements/{settlement_id}/cancel")
async def cancel_settlement(body: CancelSettlementIn, request: Request, settlement_id: str = DocId(),
                            p: Principal = Depends(require_permission("settlement.manage"))):
    return await forward(p, request, "POST", "/cancel_settlement",
                         json={"settlement_id": settlement_id, "reason": body.reason})

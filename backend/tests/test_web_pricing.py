"""Server-authoritative web pricing: web_quote / to_paise."""
from services.availability_service import to_paise, web_quote


def test_premium_nonac_price():
    assert web_quote("premium", 2, 2) == 1200 * 2


def test_premium_ac_price():
    assert web_quote("premium", 2, 2, ac=True) == (1200 + 600) * 2


def test_deluxe_price():
    assert web_quote("deluxe", 2, 1) == 900


def test_extra_guest_surcharge():
    assert web_quote("premium", 3, 2) == (1200 + 300) * 2


def test_to_paise():
    assert to_paise(900) == 90000

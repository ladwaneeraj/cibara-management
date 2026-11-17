"""Editing a register entry's guest name + members (admin & manager)."""
import config


def _seed_active(room="23", stay_id="stay_ge1"):
    """An occupied room with its draft bill (a live stay)."""
    config.bills_ref.document(stay_id).set({
        "status": "draft", "room": room, "guest_name": "Old Name", "guest_count": 1,
    })
    config.rooms_ref.document(room).set({
        "status": "occupied", "active_bill_id": stay_id,
        "guest": {"name": "Old Name", "mobile": "9999999999", "guests": 1},
    })


def _post(client, headers, **body):
    return client.post("/update_register_guest", json=body, headers=headers)


def test_admin_edits_name_and_members_on_live_stay(client, admin):
    _seed_active()
    r = _post(client, admin, bill_id="stay_ge1", room="23", guest_name="New Name", guests=3)
    assert r.status_code == 200 and r.json()["success"]

    room = config.rooms_ref.document("23").get().to_dict()
    assert room["guest"]["name"] == "New Name" and room["guest"]["guests"] == 3
    assert room["last_guest_edit"]["by"]  # who/when stamped

    bill = config.bills_ref.document("stay_ge1").get().to_dict()
    assert bill["guest_name"] == "New Name" and bill["guest_count"] == 3


def test_manager_is_allowed(client, manager):
    _seed_active(room="24", stay_id="stay_ge2")
    r = _post(client, manager, bill_id="stay_ge2", room="24", guest_name="Mgr Edit", guests=2)
    assert r.status_code == 200 and r.json()["success"]
    assert config.rooms_ref.document("24").get().to_dict()["guest"]["name"] == "Mgr Edit"


def test_staff_is_forbidden(client, staff):
    assert _post(client, staff, bill_id="stay_ge1", room="23",
                 guest_name="Nope", guests=1).status_code == 403


def test_rejects_blank_name_and_bad_count(client, admin):
    _seed_active(room="25", stay_id="stay_ge3")
    assert _post(client, admin, bill_id="stay_ge3", room="25",
                 guest_name="", guests=2).status_code == 400
    assert _post(client, admin, bill_id="stay_ge3", room="25",
                 guest_name="Ok", guests=99).status_code == 400

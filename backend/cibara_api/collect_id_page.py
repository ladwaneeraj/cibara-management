"""
Public pre-arrival guest page (served by routers/collect_id.py).

The link a guest gets in their WhatsApp booking confirmation. It carries no app
session — the signed token in the URL is the only authorisation — so everything
it needs is baked in by the server: guest name, room, their booking summary,
directions and hotel info. The guest can upload their ID here before arrival
(up to 4 photos, each removable before submitting), and once checked in hop to
the in-stay Room Services portal.

Design: an understated five-star aesthetic — Cormorant Garamond display serif,
navy + gold palette on ivory — meant to carry a hotel brand. No external
scripts (only a Google Font, allowed by the classic-UI CSP); ID photos POST to
our API (private storage), nothing is written to Firestore from here.
"""
from __future__ import annotations

import html
import json
from datetime import datetime

# Same Google Maps pin the app's WhatsApp confirmation uses.
MAPS_LINK = "https://maps.app.goo.gl/Mz5rTrvC3ctyMmUt5"


def _fmt_date(d):
    try:
        return datetime.strptime(str(d)[:10], "%Y-%m-%d").strftime("%a, %d %b %Y")
    except (ValueError, TypeError):
        return ""


def _fmt_time(t):
    try:
        h, m = str(t).split(":")[:2]
        h = int(h)
        ap = "PM" if h >= 12 else "AM"
        return f"{h % 12 or 12}:{m} {ap}"
    except (ValueError, TypeError):
        return ""


def _nights(ci, co):
    try:
        a = datetime.strptime(str(ci)[:10], "%Y-%m-%d")
        b = datetime.strptime(str(co)[:10], "%Y-%m-%d")
        return max(0, (b - a).days)
    except (ValueError, TypeError):
        return 0


def _esc(s):
    return html.escape(str(s if s is not None else ""))


def _row(k, v):
    return (f'<div class="row"><span class="k">{_esc(k)}</span>'
            f'<span class="v">{_esc(v)}</span></div>')


def _booking_card(room, booking):
    checked_in = str((booking or {}).get("status") or "") in ("checked_in", "checkedin")
    label = "Checked in" if checked_in else "Reservation confirmed"
    ci_date = _fmt_date((booking or {}).get("check_in_date"))
    ci_time = _fmt_time((booking or {}).get("check_in_time"))
    nights = _nights((booking or {}).get("check_in_date"), (booking or {}).get("check_out_date"))
    room_txt = _esc(room) if room else "Assigned at check-in"
    rows = ""
    if ci_date:
        rows += _row("Arrival", ci_date + (f" · {ci_time}" if ci_time else ""))
    if nights:
        rows += _row("Nights", str(nights))
    rows += _row("Room", room_txt)
    return (
        '<section class="card">'
        f'<span class="eyebrow">{_esc(label)}</span>'
        '<h1>Your stay</h1>'
        f'<div class="rows">{rows}</div>'
        '</section>'
    )


def _info_card(info, portal_url):
    info = info or {}
    parts = ['<section class="card"><h2>Before you arrive</h2>',
             f'<a class="line" href="{_esc(MAPS_LINK)}" target="_blank" rel="noopener">'
             '<span>Directions &amp; location</span><span class="chev">&rsaquo;</span></a>']
    phone = info.get("reception_phone")
    if phone:
        parts.append(f'<a class="line" href="tel:{_esc(phone)}">'
                     f'<span>Call reception</span><span class="chev">{_esc(phone)} &rsaquo;</span></a>')
    rows = ""
    if info.get("checkout_time"):
        rows += _row("Check-out by", info["checkout_time"])
    if info.get("wifi_name"):
        wifi = info["wifi_name"] + (f" · {info['wifi_password']}" if info.get("wifi_password") else "")
        rows += _row("Wi-Fi", wifi)
    rows += _row("Please carry", "A valid government photo ID")
    parts.append(f'<div class="rows">{rows}</div>')
    if info.get("house_rules"):
        parts.append(f'<p class="rules">{_esc(info["house_rules"])}</p>')
    if portal_url:
        parts.append(f'<a class="btn gold" href="{_esc(portal_url)}" target="_blank" rel="noopener">'
                     'Open Room Services</a>')
    parts.append('</section>')
    return "".join(parts)


def _upload_card(name):
    return _UPLOAD.replace("__NAME__", name)


def render_page(*, token, guest_name, room, already, booking=None, info=None,
                portal_url="", hotel="Cibara Comforts"):
    cfg = json.dumps({"token": token, "already": bool(already)})
    name = _esc(guest_name or "Guest")
    return (_HEAD.replace("__HOTEL__", _esc(hotel))
            + _BRAND.replace("__HOTEL__", _esc(hotel))
            + _booking_card(room, booking)
            + _upload_card(name)
            + _info_card(info, portal_url)
            + _BODY_CLOSE.replace("__CFG__", cfg).replace("__HOTEL__", _esc(hotel)))


def render_error(message: str) -> str:
    return (_HEAD.replace("__HOTEL__", "Cibara Comforts")
            + _ERROR_BODY.replace("__MSG__", _esc(message)))


_HEAD = """<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Your stay · __HOTEL__</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --navy:#161d31; --navy-soft:#26304d; --gold:#bd9e62; --gold-dk:#a1853f;
          --ink:#23262e; --muted:#8c877b; --line:#ece6da; --cream:#f6f2ea;
          --card:#fffdf9; --ok:#2f7d5b; --danger:#b3443b; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html,body { margin:0; }
  body { font-family:'Jost',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:var(--cream); color:var(--ink); font-weight:300;
         min-height:100vh; min-height:100dvh;
         padding:0 16px calc(40px + env(safe-area-inset-bottom));
         -webkit-font-smoothing:antialiased; }
  .wrap { max-width:440px; margin:0 auto; }
  h1,h2,.eyebrow,.brand .logo { font-family:'Cormorant Garamond',Georgia,serif; }
  /* Brand header */
  .brand { text-align:center; padding:34px 0 26px; }
  .brand .logo { font-size:30px; font-weight:600; letter-spacing:1.5px; color:var(--navy);
                 line-height:1; }
  .brand .rule { width:46px; height:1px; background:var(--gold); margin:12px auto 10px; }
  .brand .sub { font-size:11px; letter-spacing:3px; text-transform:uppercase;
                color:var(--muted); font-weight:400; }
  /* Cards */
  .card { background:var(--card); border:1px solid var(--line); border-radius:4px;
          padding:26px 24px; margin-bottom:16px;
          box-shadow:0 14px 34px rgba(22,29,49,.07); }
  .eyebrow { display:block; font-size:12px; letter-spacing:2.5px; text-transform:uppercase;
             color:var(--gold-dk); font-weight:600; margin-bottom:4px; }
  h1 { font-size:30px; font-weight:600; margin:0 0 16px; letter-spacing:.3px; }
  h2 { font-size:23px; font-weight:600; margin:0 0 6px; letter-spacing:.3px; }
  .lead { color:var(--muted); font-size:14px; margin:4px 0 20px; line-height:1.6; font-weight:300; }
  .rows { margin-top:2px; }
  .row { display:flex; justify-content:space-between; gap:14px; padding:11px 0;
         border-top:1px solid var(--line); font-size:14.5px; }
  .row:first-child { border-top:0; }
  .row .k { color:var(--muted); font-weight:300; } .row .v { font-weight:500; text-align:right; }
  /* Lines (directions / call) */
  .line { display:flex; justify-content:space-between; align-items:center; gap:12px;
          text-decoration:none; color:var(--ink); font-size:14.5px; font-weight:400;
          padding:14px 0; border-top:1px solid var(--line); }
  h2 + .line { border-top:0; }
  .line .chev { color:var(--gold-dk); font-weight:500; }
  /* Fields */
  label.field { display:block; font-size:12px; letter-spacing:1px; text-transform:uppercase;
                color:var(--muted); font-weight:500; margin:0 0 7px; }
  input[type=text] { width:100%; padding:13px 15px; border:1px solid var(--line);
          border-radius:3px; font-size:16px; font-family:inherit; background:#fff; color:var(--ink);
          margin:0 0 20px; }
  input[type=text]:focus { outline:none; border-color:var(--gold); }
  /* Photo slots */
  .slots { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:2px 0 20px; }
  .slot { position:relative; border:1px solid var(--line); border-radius:3px;
          aspect-ratio:1.5/1; display:flex; flex-direction:column; align-items:center;
          justify-content:center; gap:5px; cursor:pointer; overflow:hidden; background:#fbf9f4; }
  .slot.filled { border-color:var(--gold); }
  .slot img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .slot .ico { width:26px; height:26px; opacity:.5; }
  .slot .lab { font-size:12px; font-weight:500; color:var(--ink); letter-spacing:.3px; }
  .slot .opt { font-size:10.5px; color:var(--muted); letter-spacing:.5px; }
  .slot input { display:none; }
  .slot .rm { position:absolute; top:6px; right:6px; width:26px; height:26px; border:0;
          border-radius:999px; background:rgba(22,29,49,.78); color:#fff; font-size:17px;
          line-height:1; display:none; align-items:center; justify-content:center; cursor:pointer;
          backdrop-filter:blur(2px); }
  .slot.filled .rm { display:flex; }
  /* Buttons */
  .btn { display:block; width:100%; text-align:center; text-decoration:none; cursor:pointer;
         font-family:inherit; font-size:14px; font-weight:500; letter-spacing:1.5px;
         text-transform:uppercase; padding:15px; border-radius:3px; border:1px solid var(--navy); }
  .btn.primary { background:var(--navy); color:#fff; border-color:var(--navy); }
  .btn.primary:disabled { opacity:.4; cursor:not-allowed; }
  .btn.gold { background:transparent; color:var(--gold-dk); border-color:var(--gold);
              margin-top:16px; }
  .note { font-size:12px; color:var(--muted); text-align:center; margin:16px 4px 0;
          line-height:1.6; font-weight:300; }
  .rules { font-size:13px; color:var(--muted); line-height:1.6; white-space:pre-wrap;
           margin:12px 0 0; padding-top:14px; border-top:1px solid var(--line); font-weight:300; }
  .state { text-align:center; padding:14px 0 6px; }
  .state .big { font-size:30px; color:var(--gold-dk); font-family:'Cormorant Garamond',serif; }
  .state h2 { margin:10px 0 6px; }
  .state p { color:var(--muted); font-size:14px; margin:0; font-weight:300; }
  .err .big { color:var(--danger); }
  .hidden { display:none !important; }
  .err-msg { color:var(--danger); font-size:13px; text-align:center; margin:12px 0 0; min-height:18px; }
  .foot { text-align:center; color:var(--muted); font-size:10.5px; letter-spacing:2px;
          text-transform:uppercase; margin:8px 0 0; }
</style></head>"""

_BRAND = """<body><div class="wrap">
  <div class="brand"><div class="logo">__HOTEL__</div>
    <div class="rule"></div><div class="sub">Guest Services</div></div>
"""

# Camera SVG (inline, inherits currentColor) — no emoji, keeps the premium look.
_CAM = ('<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        'stroke-width="1.4"><path d="M3 8.5A2 2 0 0 1 5 6.5h1.6l1-1.6h4.8l1 1.6H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.5Z"/>'
        '<circle cx="12" cy="13" r="3.2"/></svg>')

_UPLOAD = ("""  <section class="card">
    <div id="form-view">
      <h2>Upload your ID</h2>
      <p class="lead">A clear photo of your government ID (Aadhaar, Driving Licence,
        Passport or Voter ID) lets us welcome you straight to your room. Up to four photos —
        tap the &times; to retake any.</p>
      <label class="field" for="gname">Guest name</label>
      <input type="text" id="gname" value="__NAME__" maxlength="80" autocomplete="name">
      <div class="slots">
        <label class="slot"><input type="file" accept="image/*" capture="environment" data-slot="file">
          """ + _CAM + """<span class="lab">ID front</span><span class="opt">Tap to capture</span>
          <button class="rm" type="button" aria-label="Remove">&times;</button></label>
        <label class="slot"><input type="file" accept="image/*" capture="environment" data-slot="file2">
          """ + _CAM + """<span class="lab">ID back</span><span class="opt">Optional</span>
          <button class="rm" type="button" aria-label="Remove">&times;</button></label>
        <label class="slot"><input type="file" accept="image/*" capture="environment" data-slot="file3">
          """ + _CAM + """<span class="lab">Photo 3</span><span class="opt">Optional</span>
          <button class="rm" type="button" aria-label="Remove">&times;</button></label>
        <label class="slot"><input type="file" accept="image/*" capture="environment" data-slot="file4">
          """ + _CAM + """<span class="lab">Photo 4</span><span class="opt">Optional</span>
          <button class="rm" type="button" aria-label="Remove">&times;</button></label>
      </div>
      <button class="btn primary" id="submit" disabled>Upload my ID</button>
      <div class="err-msg" id="err"></div>
      <p class="note">Your ID is sent securely to the front desk only, and is never shared.</p>
    </div>
    <div id="done-view" class="state hidden">
      <div class="big">&#10003;</div><h2>Thank you</h2>
      <p id="done-msg">Your ID has been received. We look forward to welcoming you.</p>
    </div>
  </section>
""")

_BODY_CLOSE = """  <div class="foot">__HOTEL__</div>
</div>
<script>
(function(){
  var CFG = __CFG__;
  var files = {};
  var err = document.getElementById('err');
  var submit = document.getElementById('submit');
  if (CFG.already) { showDone("We already have your ID on file \\u2014 you're all set. " +
      "You may still upload a new photo below if you'd like."); }
  function showDone(msg){
    document.getElementById('form-view').classList.add('hidden');
    var d = document.getElementById('done-view');
    if (msg) document.getElementById('done-msg').textContent = msg;
    d.classList.remove('hidden');
  }
  function refreshBtn(){ submit.disabled = !files.file; }
  function clearSlot(slot, key){
    delete files[key];
    slot.classList.remove('filled');
    var img = slot.querySelector('img'); if(img) img.remove();
    var inp = slot.querySelector('input'); if(inp) inp.value = '';
    refreshBtn();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.slot'), function(slot){
    var inp = slot.querySelector('input');
    var key = inp.getAttribute('data-slot');
    inp.addEventListener('change', function(){
      var f = inp.files && inp.files[0]; if(!f) return;
      files[key] = f;
      slot.classList.add('filled');
      var old = slot.querySelector('img'); if(old) old.remove();
      var img = document.createElement('img'); img.src = URL.createObjectURL(f);
      slot.insertBefore(img, slot.firstChild);
      err.textContent = ''; refreshBtn();
    });
    slot.querySelector('.rm').addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation(); clearSlot(slot, key);
    });
  });
  submit.addEventListener('click', function(){
    if(!files.file) return;
    submit.disabled = true; submit.textContent = 'Uploading\\u2026'; err.textContent = '';
    var fd = new FormData();
    ['file','file2','file3','file4'].forEach(function(k){ if(files[k]) fd.append(k, files[k]); });
    fd.append('name', (document.getElementById('gname').value || '').trim());
    fetch('/api/v2/collect-id/' + encodeURIComponent(CFG.token) + '/upload',
          { method:'POST', body: fd })
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
      .then(function(res){
        if (res.ok && res.j && res.j.success) { showDone(); }
        else { throw new Error((res.j && res.j.message) || 'Upload failed. Please try again.'); }
      })
      .catch(function(e){
        err.textContent = e.message || 'Upload failed. Please check your connection.';
        submit.disabled = false; submit.textContent = 'Upload my ID';
      });
  });
})();
</script></body></html>"""

_ERROR_BODY = """<body><div class="wrap">
  <div class="brand"><div class="logo">Cibara Comforts</div><div class="rule"></div>
    <div class="sub">Guest Services</div></div>
  <section class="card"><div class="state err">
    <div class="big">&#9888;</div><h2>Link not valid</h2>
    <p>__MSG__</p>
  </div></section>
  <div class="foot">Please ask the hotel to send a fresh link</div>
</div></body></html>"""

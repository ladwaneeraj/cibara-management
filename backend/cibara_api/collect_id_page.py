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

# Small inline map-pin (no icon font on the guest page), gold to match the brand.
_PIN = ('<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
        'stroke-width="1.6" style="flex:none;margin-right:9px;color:var(--gold-dk);">'
        '<path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z"/>'
        '<circle cx="12" cy="9" r="2.6"/></svg>')

# Clock glyph for the compact HH : MM check-in picker.
_CLOCK = ('<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" '
          'stroke-width="1.6" style="flex:none;color:var(--gold-dk);"><circle cx="12" cy="12" r="9"/>'
          '<path d="M12 7v5l3 2"/></svg>')


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
             f'<span style="display:inline-flex;align-items:center;">{_PIN}Directions &amp; location</span>'
             '<span class="chev">&rsaquo;</span></a>']
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


def _fmt12(hhmm):
    """24h 'HH:MM' -> 'h:MM AM/PM'; '' for empty/invalid."""
    s = str(hhmm or "")[:5]
    if ":" not in s:
        return ""
    try:
        h = int(s.split(":")[0])
        m = s.split(":")[1]
    except (ValueError, IndexError):
        return ""
    ap = "PM" if h >= 12 else "AM"
    return f"{h % 12 or 12}:{m} {ap}"


def _upload_card(name, ci_value="", ci_label=""):
    return (_UPLOAD.replace("__NAME__", name)
            .replace("__CI_VALUE__", ci_value)
            .replace("__CI_LABEL__", ci_label or "Set time"))


def render_page(*, token, guest_name, room, already, booking=None, info=None,
                portal_url="", hotel="Cibara Comforts"):
    cfg = json.dumps({"token": token, "already": bool(already)})
    name = _esc(guest_name or "Guest")
    ci_value = str((booking or {}).get("check_in_time") or "")[:5]
    return (_HEAD.replace("__HOTEL__", _esc(hotel))
            + _BRAND.replace("__HOTEL__", _esc(hotel))
            + _booking_card(room, booking)
            + _upload_card(name, _esc(ci_value), _esc(_fmt12(ci_value)))
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
  input[type=text], select { width:100%; padding:13px 15px; border:1px solid var(--line);
          border-radius:3px; font-size:16px; font-family:inherit; background:#fff; color:var(--ink);
          margin:0 0 20px; }
  input[type=text]:focus, select:focus { outline:none; border-color:var(--gold); }
  select { -webkit-appearance:none; appearance:none; cursor:pointer;
          background-image:url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' fill='none' stroke='%23bd9e62' stroke-width='2' viewBox='0 0 24 24'%3e%3cpath d='M6 9l6 6 6-6'/%3e%3c/svg%3e");
          background-repeat:no-repeat; background-position:right 12px center; padding-right:34px; }
  .timebtn { display:flex; align-items:center; gap:10px; width:100%; margin:0 0 20px;
          padding:13px 15px; border:1px solid var(--line); border-radius:3px; background:#fff;
          font-size:16px; font-family:inherit; color:var(--ink); cursor:pointer; text-align:left; }
  .timebtn:focus { outline:none; border-color:var(--gold); }
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
      <label class="field">Expected check-in time</label>
      <button type="button" id="gci-btn" class="timebtn" data-val="__CI_VALUE__">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" style="color:var(--gold-dk);flex:none;"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
        <span id="gci-label">__CI_LABEL__</span></button>
      <div class="slots">
        <label class="slot"><input type="file" accept="image/*" data-slot="file">
          """ + _CAM + """<span class="lab">ID front</span><span class="opt">Camera or gallery</span>
          <button class="rm" type="button" aria-label="Remove">&times;</button></label>
        <label class="slot"><input type="file" accept="image/*" data-slot="file2">
          """ + _CAM + """<span class="lab">ID back</span><span class="opt">Optional</span>
          <button class="rm" type="button" aria-label="Remove">&times;</button></label>
        <label class="slot"><input type="file" accept="image/*" data-slot="file3">
          """ + _CAM + """<span class="lab">Photo 3</span><span class="opt">Optional</span>
          <button class="rm" type="button" aria-label="Remove">&times;</button></label>
        <label class="slot"><input type="file" accept="image/*" data-slot="file4">
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
  // Analog clock-face check-in picker (vanilla, inline — no external scripts).
  function openClock(initial, onDone){
    var p=(initial||'').split(':'); var h24=p.length==2?(+p[0]):19;
    var st={mode:'h',ampm:h24>=12?'PM':'AM',h12:(h24%12)||12,min:p.length==2?(+p[1]):0};
    function pad(n){n=''+n;return n.length<2?'0'+n:n;}
    var GOLD='#c9a46a',D=220,R=84,C=110;
    var ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:5000;display:flex;align-items:center;justify-content:center;padding:16px;';
    ov.innerHTML='<div style="background:#0f1722;color:#fff;border-radius:16px;padding:18px;width:300px;max-width:100%;box-shadow:0 24px 60px rgba(0,0,0,.5);">'+
      '<div style="display:flex;align-items:flex-start;gap:12px;justify-content:center;margin-bottom:14px;">'+
        '<div style="display:flex;align-items:baseline;gap:3px;font-size:2.2rem;font-weight:600;">'+
          '<span id="cp-h" style="cursor:pointer;padding:1px 6px;border-radius:7px;"></span><span>:</span>'+
          '<span id="cp-m" style="cursor:pointer;padding:1px 6px;border-radius:7px;"></span></div>'+
        '<div style="display:flex;flex-direction:column;gap:4px;font-size:.78rem;font-weight:700;">'+
          '<button type="button" id="cp-am" style="border:1px solid #334155;border-radius:6px;padding:3px 9px;cursor:pointer;background:transparent;color:#cbd5e1;">AM</button>'+
          '<button type="button" id="cp-pm" style="border:1px solid #334155;border-radius:6px;padding:3px 9px;cursor:pointer;background:transparent;color:#cbd5e1;">PM</button></div>'+
      '</div>'+
      '<div id="cp-face" style="position:relative;width:220px;height:220px;margin:0 auto;border-radius:50%;background:#152033;"></div>'+
      '<button type="button" id="cp-done" style="width:100%;margin-top:16px;background:#f1efe8;color:#1e293b;border:0;border-radius:10px;padding:12px;font-weight:700;font-size:.95rem;cursor:pointer;">Done</button>'+
    '</div>';
    document.body.appendChild(ov);
    function close(){ov.remove();}
    ov.addEventListener('click',function(e){if(e.target===ov)close();});
    var face=ov.querySelector('#cp-face');
    function ang(i){return (i/12)*2*Math.PI-Math.PI/2;}
    function px(i){return C+R*Math.cos(ang(i));} function py(i){return C+R*Math.sin(ang(i));}
    function render(){
      var hEl=ov.querySelector('#cp-h'),mEl=ov.querySelector('#cp-m');
      hEl.textContent=st.h12;mEl.textContent=pad(st.min);
      hEl.style.background=st.mode=='h'?GOLD:'transparent';hEl.style.color=st.mode=='h'?'#1e293b':'#fff';
      mEl.style.background=st.mode=='m'?GOLD:'transparent';mEl.style.color=st.mode=='m'?'#1e293b':'#fff';
      var amEl=ov.querySelector('#cp-am'),pmEl=ov.querySelector('#cp-pm');
      amEl.style.background=st.ampm=='AM'?GOLD:'transparent';amEl.style.color=st.ampm=='AM'?'#1e293b':'#cbd5e1';
      pmEl.style.background=st.ampm=='PM'?GOLD:'transparent';pmEl.style.color=st.ampm=='PM'?'#1e293b':'#cbd5e1';
      var hours=st.mode=='h';var selIdx=hours?st.h12:st.min/5;
      var html='<svg width="'+D+'" height="'+D+'" style="position:absolute;inset:0;pointer-events:none;">'+
        '<line x1="'+C+'" y1="'+C+'" x2="'+px(selIdx)+'" y2="'+py(selIdx)+'" stroke="'+GOLD+'" stroke-width="2"/>'+
        '<circle cx="'+C+'" cy="'+C+'" r="3" fill="'+GOLD+'"/>'+
        '<circle cx="'+px(selIdx)+'" cy="'+py(selIdx)+'" r="18" fill="'+GOLD+'"/></svg>';
      for(var k=0;k<12;k++){var idx=hours?k+1:k;var val=hours?k+1:k*5;var sel=hours?(val==st.h12):(val==st.min);
        html+='<div data-val="'+val+'" style="position:absolute;width:34px;height:34px;left:'+(px(idx)-17)+'px;top:'+(py(idx)-17)+'px;display:flex;align-items:center;justify-content:center;border-radius:50%;cursor:pointer;font-size:.95rem;font-weight:600;z-index:1;color:'+(sel?'#1e293b':'#e2e8f0')+';">'+(hours?val:pad(val))+'</div>';}
      face.innerHTML=html;
      var els=face.querySelectorAll('[data-val]');
      for(var j=0;j<els.length;j++){(function(el){el.addEventListener('click',function(){var v=+el.getAttribute('data-val');if(st.mode=='h'){st.h12=v;st.mode='m';}else{st.min=v;}render();});})(els[j]);}
    }
    ov.querySelector('#cp-h').addEventListener('click',function(){st.mode='h';render();});
    ov.querySelector('#cp-m').addEventListener('click',function(){st.mode='m';render();});
    ov.querySelector('#cp-am').addEventListener('click',function(){st.ampm='AM';render();});
    ov.querySelector('#cp-pm').addEventListener('click',function(){st.ampm='PM';render();});
    ov.querySelector('#cp-done').addEventListener('click',function(){onDone(pad((st.h12%12)+(st.ampm=='PM'?12:0))+':'+pad(st.min));close();});
    render();
  }
  function fmt12(v){if(!v||v.indexOf(':')<0)return 'Set time';var p=v.split(':');var h=+p[0];var ap=h>=12?'PM':'AM';h=(h%12)||12;return h+':'+p[1]+' '+ap;}
  var gbtn=document.getElementById('gci-btn');
  if(gbtn){gbtn.addEventListener('click',function(){openClock(gbtn.getAttribute('data-val'),function(v){gbtn.setAttribute('data-val',v);document.getElementById('gci-label').textContent=fmt12(v);});});}
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
    var gbtn = document.getElementById('gci-btn');
    if (gbtn && gbtn.getAttribute('data-val')) fd.append('checkin', gbtn.getAttribute('data-val'));
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

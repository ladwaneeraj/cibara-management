/* ============================================================================
 * nice-select.js — a compact, styled dropdown that wraps a native <select>.
 * ----------------------------------------------------------------------------
 * A native <select> renders its option list with the operating system, not the
 * page. Those lists cannot be styled — they arrive with the OS's own row
 * height, font and colours, which on Windows Chrome means tall rows and a
 * plain blue highlight that looks nothing like the rest of the app.
 *
 * This replaces the visible control with markup we own, while KEEPING the
 * native <select> in the DOM as the single source of truth:
 *
 *   • reading `select.value` anywhere in the codebase still works;
 *   • the `change` event still fires, so existing listeners are untouched;
 *   • setting `select.value` from code updates the visible label automatically;
 *   • the element stays in the form, so constraint validation still applies.
 *
 * That last point is why the select is hidden with opacity rather than
 * `display:none`. A display-none control is not focusable, and the browser
 * refuses to report a validation message against it ("An invalid form control
 * is not focusable"), which would silently break form submission.
 *
 * Usage:
 *     CibaraSelect.enhance("expense-category");
 *     CibaraSelect.enhance(el, { placeholder: "Choose…", maxHeight: 260 });
 *
 * Per-option icons come from a `data-icon` attribute holding a Font Awesome
 * class, e.g. <option value="salary" data-icon="fa-user-tie">Salary</option>.
 * Optional — options without one simply render without an icon.
 * ==========================================================================*/

(function () {
  "use strict";

  var STYLE_ID = "cibara-nice-select-styles";
  var CSS = [
    /* Own the box model. Without this the component inherits whatever the
       host page uses: under the default content-box, a 30px min-height plus
       11px of padding renders a 41px row, and "compact" quietly isn't. */
    ".ns-wrap,.ns-wrap *,.ns-wrap *::before,.ns-wrap *::after{box-sizing:border-box;}",
    ".ns-wrap{position:relative;display:block;width:100%;}",

    /* The real <select>, kept for value + validation, visually removed.
       Not display:none — see the file header. */
    ".ns-wrap > select.ns-native{position:absolute;left:0;top:0;width:100%;",
    "  height:100%;opacity:0;pointer-events:none;margin:0;padding:0;border:0;",
    "  -webkit-appearance:none;appearance:none;}",

    /* Trigger — matches .form-control metrics so it lines up with the Date
       field beside it. */
    ".ns-btn{display:flex;align-items:center;gap:.5rem;width:100%;",
    "  padding:.5rem .7rem;border:1px solid #ddd;",
    "  border-radius:var(--border-radius,8px);",
    "  background:#fff;font:500 .95rem 'Inter',system-ui,sans-serif;color:#1a202c;",
    "  cursor:pointer;text-align:left;line-height:1.35;min-height:44px;}",
    ".ns-btn:hover{border-color:#bfc6cf;}",
    ".ns-btn:focus-visible{outline:none;border-color:#3182ce;",
    "  box-shadow:0 0 0 3px rgba(49,130,206,.18);}",
    ".ns-wrap.ns-open .ns-btn{border-color:#3182ce;",
    "  box-shadow:0 0 0 3px rgba(49,130,206,.18);}",
    ".ns-btn.ns-empty{color:#a0aec0;}",
    ".ns-btn-ico{width:18px;text-align:center;color:#718096;font-size:.9rem;flex:0 0 auto;}",
    ".ns-btn-txt{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".ns-caret{flex:0 0 auto;color:#a0aec0;font-size:.75rem;transition:transform .15s;}",
    ".ns-wrap.ns-open .ns-caret{transform:rotate(180deg);}",

    /* Panel — position:fixed and parented to <body>.
       The expense form is `overflow-y:auto`, which clips absolutely-positioned
       descendants: an in-flow panel was sliced after two rows whenever the
       Category row sat low in the scrolled form, and the remaining categories
       could not be reached. Escaping to the body avoids every ancestor clip. */
    ".ns-panel{position:fixed;z-index:6000;",
    "  background:#fff;border:1px solid #e2e8f0;border-radius:12px;",
    "  box-shadow:0 10px 28px rgba(15,23,42,.16);padding:5px;",
    "  max-height:404px;overflow-y:auto;overscroll-behavior:contain;display:none;",
    "  -webkit-overflow-scrolling:touch;}",
    ".ns-panel.ns-panel-open{display:block;}",

    /* Option rows — 44px, the minimum comfortable touch target. This used to
       be 32px to keep the panel compact; on a phone that read as "very small"
       and was easy to mis-tap. Density is not worth a wrong category. */
    ".ns-opt{display:flex;align-items:center;gap:.65rem;padding:0 .65rem;",
    "  border-radius:9px;cursor:pointer;font:500 .95rem 'Inter',system-ui,sans-serif;",
    "  color:#2d3748;line-height:1.25;height:44px;}",
    ".ns-opt:hover,.ns-opt.ns-active{background:#edf2f7;}",
    ".ns-opt:active{background:#e2e8f0;}",
    ".ns-opt.ns-chosen{background:#ebf5ff;color:#2b6cb0;font-weight:600;}",
    ".ns-opt-ico{width:20px;text-align:center;color:#a0aec0;font-size:.92rem;flex:0 0 auto;}",
    ".ns-opt.ns-chosen .ns-opt-ico{color:#3182ce;}",
    ".ns-opt-txt{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".ns-opt-tick{flex:0 0 auto;color:#3182ce;font-size:.82rem;visibility:hidden;}",
    ".ns-opt.ns-chosen .ns-opt-tick{visibility:visible;}",
    ".ns-opt.ns-placeholder{color:#a0aec0;}",
    ".ns-sep{height:1px;background:#edf2f7;margin:4px 6px;}"
  ].join("");

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // Must match .ns-opt height / .ns-panel padding in CSS above.
  var ROW_H = 44, PANEL_PAD = 10, DEFAULT_MAX = 9;  // show 9 rows by default
  var MIN_PANEL_W = 240;                            // never narrower than this

  /**
   * Snap a pixel budget down to a whole number of rows.
   *
   * A panel whose height is not a multiple of the row height slices the last
   * visible row through the middle of its text, which reads as a rendering
   * fault rather than as "scroll for more". Callers shouldn't have to know the
   * row height to avoid that, so the component enforces it.
   */
  function snapHeight(px) {
    var rows = Math.max(1, Math.floor((px - PANEL_PAD) / ROW_H));
    return rows * ROW_H + PANEL_PAD;
  }

  var openInstance = null;   // only one panel open at a time

  function NiceSelect(select, opts) {
    opts = opts || {};
    this.select = select;
    this.opts = opts;
    this.activeIdx = -1;
    this.typeBuf = "";
    this.typeAt = 0;
    this.build();
  }

  NiceSelect.prototype.build = function () {
    var self = this;
    var sel = this.select;

    var wrap = document.createElement("div");
    wrap.className = "ns-wrap";
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add("ns-native");
    // The native control is invisible; nothing should tab to it.
    //
    // Deliberately NOT aria-hidden: the field's <label for> points at this
    // element, and hiding it from the accessibility tree left the visible
    // control with no accessible name. Instead the button borrows the label,
    // and clicking the label is redirected to the button so focus never lands
    // on something the user cannot see.
    sel.setAttribute("tabindex", "-1");

    var labelEl = sel.id
      ? document.querySelector('label[for="' + sel.id + '"]') : null;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ns-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    if (labelEl) {
      if (!labelEl.id) labelEl.id = (sel.id || "ns") + "-label";
      btn.setAttribute("aria-labelledby", labelEl.id);
      labelEl.addEventListener("click", function (e) {
        e.preventDefault();
        btn.focus();
      });
    } else if (sel.getAttribute("aria-label")) {
      btn.setAttribute("aria-label", sel.getAttribute("aria-label"));
    }
    btn.innerHTML =
      '<i class="ns-btn-ico fas"></i>' +
      '<span class="ns-btn-txt"></span>' +
      '<i class="ns-caret fas fa-chevron-down"></i>';

    var panel = document.createElement("div");
    panel.className = "ns-panel";
    panel.setAttribute("role", "listbox");
    this.maxH = snapHeight(this.opts.maxHeight || (ROW_H * DEFAULT_MAX + PANEL_PAD));
    panel.style.maxHeight = this.maxH + "px";

    wrap.appendChild(btn);
    document.body.appendChild(panel);   // see the .ns-panel comment above

    this.wrap = wrap;
    this.btn = btn;
    this.panel = panel;

    this.renderOptions();
    this.syncLabel();

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      self.toggle();
    });
    btn.addEventListener("keydown", function (e) { self.onKey(e); });
    panel.addEventListener("keydown", function (e) { self.onKey(e); });

    // Anything that sets select.value from code (edit prefill, form reset)
    // fires change — mirror it onto the trigger.
    sel.addEventListener("change", function () { self.syncLabel(); });
  };

  NiceSelect.prototype.renderOptions = function () {
    var self = this;
    var frag = document.createDocumentFragment();
    this.rows = [];

    // An empty-valued option is the "Select…" prompt. On a required field it
    // is not a choice the operator can make, so it is not listed — the
    // trigger already shows the placeholder. Listing it also put a tick
    // against "Select…", which read as though nothing-selected was a
    // deliberate selection. Optional selects keep it as a clear/none row.
    var dropEmpty = this.select.hasAttribute("required") &&
                    this.opts.keepEmptyOption !== true;

    Array.prototype.forEach.call(this.select.options, function (o, i) {
      // hidden / disabled options are NOT choices. The expense form gates
      // categories exactly this way — `opt.hidden = opt.disabled = !mayGive`
      // for Staff Advance, and both for account-only categories on a daily
      // expense. Rendering them anyway turned a permission check into
      // decoration: setting select.value to a disabled option's value still
      // selects it, so the gate was bypassable by tapping the row.
      if (o.disabled || o.hidden) return;
      if (dropEmpty && o.value === "") return;
      var row = document.createElement("div");
      row.className = "ns-opt" + (o.value === "" ? " ns-placeholder" : "");
      row.setAttribute("role", "option");
      row.dataset.value = o.value;
      row.dataset.idx = String(i);
      var ico = o.getAttribute("data-icon") || "";
      row.innerHTML =
        '<i class="ns-opt-ico fas ' + ico + '"></i>' +
        '<span class="ns-opt-txt"></span>' +
        '<i class="ns-opt-tick fas fa-check"></i>';
      row.querySelector(".ns-opt-txt").textContent = o.textContent.trim();
      row.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        self.choose(o.value);
      });
      frag.appendChild(row);
      self.rows.push(row);
    });

    this.panel.innerHTML = "";
    this.panel.appendChild(frag);
    // Rows were replaced; a stale index would index past the new array and
    // throw on the next Enter press.
    this.activeIdx = -1;
  };

  NiceSelect.prototype.syncLabel = function () {
    var o = this.select.options[this.select.selectedIndex];
    var txt = o ? o.textContent.trim() : "";
    var val = o ? o.value : "";
    var ico = o ? (o.getAttribute("data-icon") || "") : "";

    // With nothing chosen, prefer the caller's placeholder over the markup's
    // own empty option text ("Select…" is less useful than "Select a
    // category…" when several dropdowns sit on one form).
    this.btn.querySelector(".ns-btn-txt").textContent =
      (!val && this.opts.placeholder) ? this.opts.placeholder : (txt || "Select…");
    this.btn.classList.toggle("ns-empty", !val);

    var bIco = this.btn.querySelector(".ns-btn-ico");
    bIco.className = "ns-btn-ico fas " + ico;
    bIco.style.display = ico ? "" : "none";

    this.rows.forEach(function (r) {
      r.classList.toggle("ns-chosen", !!val && r.dataset.value === val);
    });
  };

  NiceSelect.prototype.choose = function (value) {
    if (this.select.disabled) return;
    if (this.select.value !== value) {
      this.select.value = value;
      // A native select fires BOTH input and change. This codebase listens on
      // input in several places, so emitting only change would silently skip
      // those handlers.
      this.select.dispatchEvent(new Event("input", { bubbles: true }));
      this.select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    this.syncLabel();
    this.close();
    this.btn.focus();
  };

  /** Place the fixed panel against the trigger, flipping up when needed. */
  NiceSelect.prototype.position = function () {
    var r = this.btn.getBoundingClientRect();
    var p = this.panel;
    // At least MIN_PANEL_W so a narrow trigger (the Category field is a third
    // of its row) doesn't ellipsis every option label, but never wider than
    // the viewport allows.
    var w = Math.min(Math.max(r.width, MIN_PANEL_W), window.innerWidth - 8);
    p.style.width = w + "px";
    p.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + "px";

    var need = Math.min(p.scrollHeight + 10, this.maxH);
    var below = window.innerHeight - r.bottom;
    if (below < need && r.top > below) {
      // Flip up. Cap the height to what is actually available so the panel
      // never runs off the top of the screen.
      p.style.maxHeight = snapHeight(Math.min(this.maxH, r.top - 8)) + "px";
      p.style.top = "";
      p.style.bottom = (window.innerHeight - r.top + 4) + "px";
    } else {
      p.style.maxHeight = snapHeight(Math.min(this.maxH, below - 8)) + "px";
      p.style.bottom = "";
      p.style.top = (r.bottom + 4) + "px";
    }
  };

  NiceSelect.prototype.open = function () {
    if (this.select.disabled) return;
    if (openInstance && openInstance !== this) openInstance.close();
    openInstance = this;
    this.wrap.classList.add("ns-open");
    this.panel.classList.add("ns-panel-open");
    this.btn.setAttribute("aria-expanded", "true");
    this.position();

    var chosen = this.panel.querySelector(".ns-chosen");
    this.setActive(chosen ? this.rows.indexOf(chosen) : 0);
    if (chosen) chosen.scrollIntoView({ block: "nearest" });
  };

  NiceSelect.prototype.close = function () {
    this.wrap.classList.remove("ns-open", "ns-up");
    this.panel.classList.remove("ns-panel-open");
    this.btn.setAttribute("aria-expanded", "false");
    this.setActive(-1);
    if (openInstance === this) openInstance = null;
  };

  NiceSelect.prototype.toggle = function () {
    if (this.select.disabled) return;
    if (this.wrap.classList.contains("ns-open")) this.close(); else this.open();
  };

  NiceSelect.prototype.setActive = function (i) {
    this.rows.forEach(function (r) { r.classList.remove("ns-active"); });
    this.activeIdx = i;
    if (i >= 0 && this.rows[i]) {
      this.rows[i].classList.add("ns-active");
      this.rows[i].scrollIntoView({ block: "nearest" });
    }
  };

  NiceSelect.prototype.move = function (delta) {
    if (!this.rows.length) return;
    var i = this.activeIdx < 0 ? 0 : this.activeIdx + delta;
    if (i < 0) i = this.rows.length - 1;
    if (i >= this.rows.length) i = 0;
    this.setActive(i);
  };

  NiceSelect.prototype.onKey = function (e) {
    var isOpen = this.wrap.classList.contains("ns-open");

    if (e.key === "Escape") {
      if (isOpen) { e.preventDefault(); this.close(); }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen) { this.open(); return; }
      this.move(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!isOpen) { this.open(); return; }
      if (this.activeIdx >= 0) this.choose(this.rows[this.activeIdx].dataset.value);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      if (!isOpen) return;
      e.preventDefault();
      this.setActive(e.key === "Home" ? 0 : this.rows.length - 1);
      return;
    }
    // Type-ahead: typing "sa" jumps to Salary, the way a native select does.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var now = Date.now();
      this.typeBuf = (now - this.typeAt > 900) ? e.key : this.typeBuf + e.key;
      this.typeAt = now;
      var q = this.typeBuf.toLowerCase();
      if (!isOpen) this.open();
      for (var i = 0; i < this.rows.length; i++) {
        var t = this.rows[i].querySelector(".ns-opt-txt").textContent.toLowerCase();
        if (t.indexOf(q) === 0) { this.setActive(i); break; }
      }
    }
  };

  // One document-level listener closes whichever panel is open.
  document.addEventListener("click", function (e) {
    if (!openInstance) return;
    if (openInstance.wrap.contains(e.target)) return;
    if (openInstance.panel.contains(e.target)) return;   // panel lives on <body>
    openInstance.close();
  });
  // A panel positioned against the viewport must not linger while the modal
  // scrolls underneath it.
  window.addEventListener("resize", function () {
    if (openInstance) openInstance.close();
  });
  // Capture phase so scrolling INSIDE the modal body counts, not just the page.
  window.addEventListener("scroll", function () {
    if (openInstance) openInstance.position();
  }, true);

  /**
   * Enhance a <select>. Idempotent — calling it twice on the same element
   * returns the existing instance, so it is safe to call on every modal open.
   */
  function enhance(elOrId, opts) {
    var sel = typeof elOrId === "string"
      ? document.getElementById(elOrId) : elOrId;
    if (!sel || sel.tagName !== "SELECT" || !sel.parentNode) return null;
    if (sel._niceSelect) { sel._niceSelect.renderOptions(); sel._niceSelect.syncLabel(); return sel._niceSelect; }
    ensureStyles();
    sel._niceSelect = new NiceSelect(sel, opts || {});
    return sel._niceSelect;
  }

  /** Re-read options and the current value — call after populating a select. */
  function refresh(elOrId) {
    var sel = typeof elOrId === "string"
      ? document.getElementById(elOrId) : elOrId;
    if (sel && sel._niceSelect) {
      sel._niceSelect.renderOptions();
      sel._niceSelect.syncLabel();
    }
  }

  window.CibaraSelect = { enhance: enhance, refresh: refresh };
})();

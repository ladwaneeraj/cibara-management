/* ─────────────────────────────────────────────────────────────────────────
 * expense-presets-admin.js
 *
 * Admin UI for managing the quick-pick tiles that operators see inside
 * the expense modal. Opened from:
 *   • the Settings modal (card "Expense Quick-Pick Tiles"), or
 *   • the "Manage list" link inside the expense modal itself.
 *
 * Every write hits the /expense_presets/* endpoints which are gated by
 * the  expense.presets.manage  permission (admin-only by default).
 * After any successful write we invalidate the cache used by expense.js
 * so the next time a category is selected the operator sees the
 * updated tile set.
 * ─────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  // Mirror of services.expense_presets_service.ALLOWED_CATEGORIES with
  // human-readable labels. Order here drives the order of cards in the
  // admin manager modal.
  const CATEGORIES = [
    { key: "salary",             label: "Salary (staff names)",
      hint: "e.g. Ramu, Lakshmi, Suresh — used as the Paid To value." },
    { key: "utilities",          label: "Utilities",
      hint: "e.g. Electricity Bill, Water Bill, Internet, Gas." },
    { key: "rent",               label: "Rent",
      hint: "Recurring rent line items." },
    { key: "petty_cash",         label: "Petty Cash",
      hint: "e.g. Tea, Coffee, Stationery, Auto fare." },
    { key: "maintenance",        label: "Maintenance",
      hint: "e.g. Plumber, Electrician, AC service." },
    { key: "sanitary",           label: "Sanitary / Housekeeping",
      hint: "e.g. Phenyl, Detergent, Bin liners." },
    { key: "purchase",           label: "Purchase",
      hint: "Optional — Purchase usually carries a one-off vendor name." },
    { key: "booking_commission", label: "Booking Commission",
      hint: "Optional — has its own structured fields." },
    { key: "others",             label: "Others",
      hint: "Catch-all preset names." },
  ];

  let _data = {};        // category → [items]
  let _opening = false;  // re-entry guard

  function _esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ── Open ────────────────────────────────────────────────────────────────
  async function openExpensePresetManager(focusCategory) {
    if (_opening) return;
    _opening = true;
    try {
      // Hard gate — UI is hidden for non-admins, but check anyway.
      const isAdmin = window.CibaraAuth
        && typeof window.CibaraAuth.userCan === "function"
        && window.CibaraAuth.userCan("expense.presets.manage");
      if (!isAdmin) {
        if (typeof showNotification === "function") {
          showNotification("Only admins can manage expense tile presets.", "error");
        }
        return;
      }

      // Close settings modal if open (avoid stacked backdrops on mobile)
      const settingsModal = document.getElementById("settings-modal");
      if (settingsModal) settingsModal.classList.remove("show");

      await _fetchAll();
      _render(focusCategory || "");

      const modal = document.getElementById("exp-preset-manager-modal");
      if (modal) modal.classList.add("show");
    } finally {
      _opening = false;
    }
  }
  window.openExpensePresetManager = openExpensePresetManager;

  // ── Fetch ───────────────────────────────────────────────────────────────
  async function _fetchAll() {
    try {
      const res = await apiFetch("/expense_presets", { method: "GET" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (data && data.success) {
        _data = data.presets || {};
      } else {
        _data = {};
      }
    } catch (e) {
      console.error("preset fetch failed:", e);
      _data = {};
      if (typeof showNotification === "function") {
        showNotification("Failed to load presets: " + e.message, "error");
      }
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function _render(focusCategory) {
    const body = document.getElementById("exp-preset-manager-body");
    if (!body) return;

    body.innerHTML = "";
    CATEGORIES.forEach((cat) => {
      const items = _data[cat.key] || [];
      const card = document.createElement("div");
      card.className = "exp-preset-mgr-category";
      card.dataset.category = cat.key;

      // Highlight the focus category, if any
      if (focusCategory && focusCategory === cat.key) {
        card.style.borderColor = "#e53e3e";
        card.style.background  = "#fff5f5";
      }

      const itemsHtml = items.length === 0
        ? `<div style="font-size:0.78rem;color:#a0aec0;font-style:italic;">No tiles yet — add one below.</div>`
        : items.map((it) => `
            <div class="exp-preset-mgr-row" data-id="${_esc(it.id)}">
              <div class="name" title="${_esc(it.name)}">${_esc(it.name)}</div>
              <div class="amt">${it.default_amount ? "₹" + it.default_amount : ""}</div>
              <div class="row-actions">
                <button type="button" class="edit"   title="Rename / change default"><i class="fas fa-pen"></i></button>
                <button type="button" class="del"    title="Delete"><i class="fas fa-trash"></i></button>
              </div>
            </div>`).join("");

      card.innerHTML = `
        <h4>
          <span>${_esc(cat.label)} <span style="font-weight:normal;opacity:0.6;font-size:0.75rem;">(${items.length})</span></span>
        </h4>
        <div style="font-size:0.72rem;color:#718096;margin-bottom:0.5rem;">${_esc(cat.hint)}</div>
        <div class="exp-preset-mgr-list">${itemsHtml}</div>
        <div class="exp-preset-mgr-add">
          <input type="text"   class="name-input" placeholder="Name (e.g. ${_esc(_examplePlaceholder(cat.key))})" maxlength="80" />
          <input type="number" class="amt-input"  placeholder="Default ₹ (opt)" min="1" />
          <button type="button" class="add-btn"><i class="fas fa-plus"></i> Add</button>
        </div>
      `;

      // Wire add button
      const nameInput = card.querySelector(".name-input");
      const amtInput  = card.querySelector(".amt-input");
      const addBtn    = card.querySelector(".add-btn");

      const submitAdd = async () => {
        const name   = nameInput.value.trim();
        const amount = amtInput.value.trim();
        if (!name) {
          nameInput.focus();
          return;
        }
        addBtn.disabled = true;
        try {
          const res = await apiFetch(`/expense_presets/${encodeURIComponent(cat.key)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name,
              default_amount: amount === "" ? null : parseInt(amount, 10),
            }),
          });
          const data = await res.json();
          if (data && data.success) {
            // Refresh just this category
            if (!_data[cat.key]) _data[cat.key] = [];
            _data[cat.key].push(data.item);
            _invalidateOperatorCache();
            _render(cat.key);
            if (typeof showNotification === "function") {
              showNotification("Tile added", "success");
            }
          } else {
            if (typeof showNotification === "function") {
              showNotification(data.message || "Failed to add", "error");
            }
          }
        } catch (e) {
          if (typeof showNotification === "function") {
            showNotification("Error: " + e.message, "error");
          }
        } finally {
          addBtn.disabled = false;
        }
      };

      addBtn.addEventListener("click", submitAdd);
      nameInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); submitAdd(); }
      });
      amtInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); submitAdd(); }
      });

      // Wire row actions (edit / delete) using event delegation
      card.querySelectorAll(".exp-preset-mgr-row").forEach((row) => {
        const id = row.dataset.id;
        const editBtn = row.querySelector(".edit");
        const delBtn  = row.querySelector(".del");

        if (editBtn) editBtn.addEventListener("click", () => _onEditItem(cat.key, id));
        if (delBtn)  delBtn.addEventListener("click",  () => _onDeleteItem(cat.key, id));
      });

      body.appendChild(card);
    });
  }

  // ── Edit ────────────────────────────────────────────────────────────────
  async function _onEditItem(category, itemId) {
    const items = _data[category] || [];
    const current = items.find((it) => it.id === itemId);
    if (!current) return;

    const newName = prompt("Rename tile:", current.name || "");
    if (newName === null) return;            // cancelled
    const trimmed = newName.trim();
    if (!trimmed) {
      if (typeof showNotification === "function") {
        showNotification("Name cannot be empty", "error");
      }
      return;
    }

    const amtRaw = prompt(
      "Default amount in ₹ (leave blank for none):",
      current.default_amount != null ? String(current.default_amount) : "",
    );
    if (amtRaw === null) return;             // cancelled
    let defAmt = null;
    if (amtRaw.trim() !== "") {
      const n = parseInt(amtRaw.trim(), 10);
      if (isNaN(n) || n <= 0) {
        if (typeof showNotification === "function") {
          showNotification("Amount must be a positive integer or blank", "error");
        }
        return;
      }
      defAmt = n;
    }

    try {
      const res = await apiFetch(
        `/expense_presets/${encodeURIComponent(category)}/${encodeURIComponent(itemId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed, default_amount: defAmt }),
        }
      );
      const data = await res.json();
      if (data && data.success) {
        // Update local cache
        current.name = trimmed;
        current.default_amount = defAmt;
        _invalidateOperatorCache();
        _render(category);
        if (typeof showNotification === "function") {
          showNotification("Tile updated", "success");
        }
      } else {
        if (typeof showNotification === "function") {
          showNotification(data.message || "Update failed", "error");
        }
      }
    } catch (e) {
      if (typeof showNotification === "function") {
        showNotification("Error: " + e.message, "error");
      }
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────
  async function _onDeleteItem(category, itemId) {
    const items = _data[category] || [];
    const current = items.find((it) => it.id === itemId);
    if (!current) return;
    if (!confirm(`Remove "${current.name}" from ${category}?`)) return;

    try {
      const res = await apiFetch(
        `/expense_presets/${encodeURIComponent(category)}/${encodeURIComponent(itemId)}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (data && data.success) {
        _data[category] = items.filter((it) => it.id !== itemId);
        _invalidateOperatorCache();
        _render(category);
        if (typeof showNotification === "function") {
          showNotification("Tile removed", "success");
        }
      } else {
        if (typeof showNotification === "function") {
          showNotification(data.message || "Delete failed", "error");
        }
      }
    } catch (e) {
      if (typeof showNotification === "function") {
        showNotification("Error: " + e.message, "error");
      }
    }
  }

  // ── Misc ────────────────────────────────────────────────────────────────
  function _invalidateOperatorCache() {
    if (typeof window.invalidateExpensePresetsCache === "function") {
      window.invalidateExpensePresetsCache();
    }
  }

  function _examplePlaceholder(category) {
    switch (category) {
      case "salary":             return "Ramu";
      case "utilities":          return "Electricity Bill";
      case "rent":               return "Shop Rent";
      case "petty_cash":         return "Tea";
      case "maintenance":        return "Plumber";
      case "sanitary":           return "Phenyl";
      case "purchase":           return "Towels stock";
      case "booking_commission": return "Booking.com";
      default:                   return "Item name";
    }
  }

  // Close on backdrop click
  document.addEventListener("DOMContentLoaded", function () {
    const modal = document.getElementById("exp-preset-manager-modal");
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.classList.remove("show");
      });
    }
  });
})();

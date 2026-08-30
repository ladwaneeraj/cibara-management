// Booking Module Variables
let bookings = [];
let filteredBookings = [];
let currentBookingFilter = "upcoming";
let _activeBookingForWhatsApp = null; // stores the full booking object currently shown in details modal

// OTA prepaid sources behave identically in the UI (prepaid, settles via OTA,
// no money collected from the guest at the hotel): MMT and Agoda.
const OTA_PREPAID_SOURCES = ["mmt", "agoda"];
function isOtaPrepaid(src) {
  return OTA_PREPAID_SOURCES.includes(src);
}
// Display label for an OTA source badge / details panel.
function otaSourceLabel(src) {
  if (src === "mmt") return "MMT";
  if (src === "agoda") return "Agoda";
  return (src || "").toUpperCase();
}

// DOM Elements
document.addEventListener("DOMContentLoaded", function () {
  // Initialize booking tab
  const bookingNavItem = document.querySelector(
    '.nav-item[data-tab="bookings"]',
  );
  if (bookingNavItem) {
    bookingNavItem.addEventListener("click", function () {
      // Update nav items
      document.querySelectorAll(".nav-item").forEach((navItem) => {
        navItem.classList.remove("active");
      });
      this.classList.add("active");

      // Update tabs content
      document.querySelectorAll(".tab-content").forEach((content) => {
        content.classList.add("hidden");
      });

      const bookingsTab = document.getElementById("bookings-tab");
      if (bookingsTab) {
        bookingsTab.classList.remove("hidden");
        fetchBookings(); // Refresh bookings when tab is opened
      }
    });
  }

  // New Booking Button
  const newBookingBtn = document.getElementById("new-booking-btn");
  if (newBookingBtn) {
    newBookingBtn.addEventListener("click", showNewBookingModal);
  }

  // MMT Settlements Button
  const mmtSettlementsBtn = document.getElementById("mmt-settlements-btn");
  if (mmtSettlementsBtn) {
    mmtSettlementsBtn.addEventListener("click", showMmtSettlementsModal);
  }

  // Fetch-from-MMT button — manually pull new voucher/settlement emails on
  // demand (instead of waiting for a scheduled poll). Calls /mmt/ingest with
  // the logged-in user's auth, then reloads the bookings list.
  const fetchMmtBtn = document.getElementById("fetch-mmt-btn");
  if (fetchMmtBtn) {
    fetchMmtBtn.addEventListener("click", fetchFromMmt);
  }

  // Close MMT Settlements Modal
  const closeMmtSettlementsBtn = document.getElementById("close-mmt-settlements-btn");
  if (closeMmtSettlementsBtn) {
    closeMmtSettlementsBtn.addEventListener("click", function () {
      const modal = document.getElementById("mmt-settlements-modal");
      if (modal) modal.classList.remove("show");
    });
  }

  // Initialize Booking Form
  initializeBookingForm();

  // Modal close-btn handler is centralized in script.js (scopes to the
  // nearest .modal-backdrop so nested modals don't close their parents).
  // The duplicate handler that used to live here closed every backdrop on
  // the page, which broke the edit-time modal nested inside the check-in
  // modal. Removed intentionally — do not re-add without scoping.

  // Initialize Booking Filters
  document.querySelectorAll(".booking-filter-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".booking-filter-btn").forEach((b) => {
        b.classList.remove("active");
      });
      this.classList.add("active");
      currentBookingFilter = this.dataset.filter;
      renderBookings();
    });
  });

  // Initialize Convert Booking Form
  initializeConvertBookingForm();

  // Initialize Cancel Booking Form
  initializeCancelBookingForm();

  // Initialize Update Booking Form
  initializeUpdateBookingForm();
});

// ── Booking-form price auto-calculator ──────────────────────────────────────
// Returns per-night rate for a room + guest count (mirrors script.js roomPricing)
function getBookingRatePerNight(roomNumber, guestCount) {
  roomNumber = String(roomNumber);
  guestCount = parseInt(guestCount) || 1;
  const n = parseInt(roomNumber);

  if ((n >= 3 && n <= 5) || (n >= 13 && n <= 20)) return 250;
  if (n >= 23 && n <= 27) return guestCount === 1 ? 300 : 500;
  if (["200","201","202","203","204","205","206","207"].includes(roomNumber)) {
    return 1200 + Math.max(0, guestCount - 2) * 300;
  }
  if (n >= 223 && n <= 227) return 900 + Math.max(0, guestCount - 2) * 300;
  if (n >= 220 && n <= 222) return guestCount === 1 ? 450 : 700 + Math.max(0, guestCount - 2) * 300;
  if ((n >= 208 && n <= 211) || n === 215) return guestCount === 1 ? 450 : 700 + Math.max(0, guestCount - 2) * 300;
  if ((n >= 212 && n <= 214) || (n >= 216 && n <= 219)) return guestCount === 1 ? 450 : 700;
  return 500;
}

// AC rooms in the booking form (200-206, not 207 which has no AC)
const BOOKING_AC_ROOMS = ["200","201","202","203","204","205","206"];
const BOOKING_AC_SURCHARGE = 600;

function updateBookingPriceCalc() {
  const roomSelect   = document.getElementById("booking-room");
  const checkInEl    = document.getElementById("booking-check-in");
  const checkOutEl   = document.getElementById("booking-check-out");
  const guestCountEl = document.getElementById("booking-guest-count");
  const rateEl       = document.getElementById("booking-rate-per-night");
  const totalEl      = document.getElementById("booking-total-amount");
  const nightsEl     = document.getElementById("booking-nights-count");
  const acToggle     = document.getElementById("booking-ac-toggle");
  const acContainer  = document.getElementById("booking-ac-toggle-container");
  const acLabel      = document.getElementById("booking-ac-label");
  const acSlider     = document.getElementById("booking-ac-slider");

  const room      = roomSelect ? roomSelect.value : "";
  const checkIn   = checkInEl ? checkInEl.value : "";
  const checkOut  = checkOutEl ? checkOutEl.value : "";
  const guests    = guestCountEl ? parseInt(guestCountEl.value) || 1 : 1;

  // Show/hide AC toggle
  const isAcRoom = BOOKING_AC_ROOMS.includes(String(room));
  if (acContainer) acContainer.style.display = isAcRoom ? "block" : "none";
  if (!isAcRoom && acToggle) acToggle.checked = false;

  // Update AC label + slider color dynamically
  if (acToggle && acLabel && acSlider) {
    const on = acToggle.checked;
    acLabel.textContent = on ? "ON" : "OFF";
    acLabel.style.color = on ? "#0284c7" : "#64748b";
    acSlider.style.background = on ? "#0ea5e9" : "#cbd5e1";
  }

  // Calculate nights
  let nights = 0;
  if (checkIn && checkOut) {
    const ci = new Date(checkIn);
    const co = new Date(checkOut);
    nights = Math.round((co - ci) / (1000 * 60 * 60 * 24));
  }
  if (nightsEl) nightsEl.textContent = nights > 0 ? nights : "0";

  if (!room || nights <= 0) return;

  // Base rate + AC surcharge
  let rate = getBookingRatePerNight(room, guests);
  if (isAcRoom && acToggle && acToggle.checked) rate += BOOKING_AC_SURCHARGE;

  if (rateEl) rateEl.value = rate;
  if (totalEl) {
    totalEl.value = rate * nights;
    // Fire input event so remaining recalculates
    totalEl.dispatchEvent(new Event("input"));
  }
}

// Initialize Booking Form
function initializeBookingForm() {
  const bookingForm = document.getElementById("booking-form");
  if (!bookingForm) return;

  // Handle check dates change
  const checkInDate = document.getElementById("booking-check-in");
  const checkOutDate = document.getElementById("booking-check-out");

  if (checkInDate && checkOutDate) {
    // Set min date to today
    const today = new Date().toISOString().split("T")[0];
    checkInDate.min = today;
    checkOutDate.min = today;

    // Update checkout min date when checkin changes
    checkInDate.addEventListener("change", function () {
      checkOutDate.min = this.value;
      if (checkOutDate.value && checkOutDate.value < this.value) {
        checkOutDate.value = this.value;
      }
      checkAvailability();
    });

    checkOutDate.addEventListener("change", function () {
      checkAvailability();
    });
  }

  // Rate-per-night field: when manually changed, recalc total
  const ratePerNightEl = document.getElementById("booking-rate-per-night");
  if (ratePerNightEl) {
    ratePerNightEl.addEventListener("input", function () {
      const checkIn  = document.getElementById("booking-check-in")?.value;
      const checkOut = document.getElementById("booking-check-out")?.value;
      if (!checkIn || !checkOut) return;
      const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24));
      const rate   = parseInt(this.value) || 0;
      const totalEl = document.getElementById("booking-total-amount");
      if (totalEl && nights > 0) {
        totalEl.value = rate * nights;
        totalEl.dispatchEvent(new Event("input"));
      }
    });
  }

  // Guest count change → recalc price
  const guestCountEl = document.getElementById("booking-guest-count");
  if (guestCountEl) {
    guestCountEl.addEventListener("input", updateBookingPriceCalc);
    guestCountEl.addEventListener("change", updateBookingPriceCalc);
  }

  // AC toggle change → recalc price
  const acToggle = document.getElementById("booking-ac-toggle");
  if (acToggle) {
    acToggle.addEventListener("change", updateBookingPriceCalc);
  }

  // Room selection change → show/hide AC toggle + recalc price
  const roomSelect = document.getElementById("booking-room");
  if (roomSelect) {
    roomSelect.addEventListener("change", updateBookingPriceCalc);
  }

  // Booking Source toggle
  const bookingSourceSelect = document.getElementById("booking-source");
  const normalPaymentFields = document.getElementById("booking-normal-payment-fields");
  const mmtFields = document.getElementById("booking-mmt-fields");

  function handleBookingSourceChange() {
    const source = bookingSourceSelect ? bookingSourceSelect.value : "normal";
    const totalAmountInput = document.getElementById("booking-total-amount");
    const otaTotalInput = document.getElementById("booking-ota-total");
    if (isOtaPrepaid(source)) {
      if (normalPaymentFields) normalPaymentFields.style.display = "none";
      if (mmtFields) mmtFields.style.display = "block";
      // Remove required from hidden field so browser doesn't block submission silently
      if (totalAmountInput) totalAmountInput.removeAttribute("required");
      // Add required to visible MMT field
      if (otaTotalInput) otaTotalInput.setAttribute("required", "");
    } else {
      if (normalPaymentFields) normalPaymentFields.style.display = "block";
      if (mmtFields) mmtFields.style.display = "none";
      // Restore required on total amount for normal/booking.com
      if (totalAmountInput) totalAmountInput.setAttribute("required", "");
      // Remove required from hidden MMT field
      if (otaTotalInput) otaTotalInput.removeAttribute("required");
    }
  }

  if (bookingSourceSelect) {
    bookingSourceSelect.addEventListener("change", handleBookingSourceChange);
    handleBookingSourceChange(); // Apply on load
  }

  // MMT net_receivable auto-calc
  function recalcNetReceivable() {
    const otaTotal = parseFloat(document.getElementById("booking-ota-total")?.value) || 0;
    const otaComm = parseFloat(document.getElementById("booking-ota-commission")?.value) || 0;
    const otaGst = parseFloat(document.getElementById("booking-ota-commission-gst")?.value) || 0;
    const net = otaTotal - otaComm - otaGst;
    const netDisplay = document.getElementById("booking-net-receivable");
    if (netDisplay) netDisplay.textContent = "₹" + (net >= 0 ? net.toFixed(0) : 0);
  }

  ["booking-ota-total", "booking-ota-commission", "booking-ota-commission-gst"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", recalcNetReceivable);
  });

  // Payment Method Selection
  document.querySelectorAll("#booking-form .payment-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#booking-form .payment-btn").forEach((b) => {
        b.classList.remove("active");
      });
      this.classList.add("active");
      const paymentMethod = this.dataset.payment;
      document.getElementById("booking-payment-method").value = paymentMethod;
    });
  });

  // Handle partial payment input
  const totalAmount = document.getElementById("booking-total-amount");
  const partialPayment = document.getElementById("booking-partial-payment");
  const remainingAmount = document.getElementById("booking-remaining-amount");

  if (totalAmount && partialPayment && remainingAmount) {
    // Calculate remaining amount
    const calculateRemaining = () => {
      const total = parseInt(totalAmount.value) || 0;
      const partial = parseInt(partialPayment.value) || 0;
      const remaining = total - partial;

      remainingAmount.textContent = "₹" + remaining;

      // Validate partial payment is not greater than total
      if (partial > total) {
        partialPayment.setCustomValidity(
          "Partial payment cannot exceed total amount",
        );
      } else {
        partialPayment.setCustomValidity("");
      }
    };

    totalAmount.addEventListener("input", calculateRemaining);
    partialPayment.addEventListener("input", calculateRemaining);
  }

  // OTA Settlement modal wiring
  const otaSettlementForm = document.getElementById("ota-settlement-form");
  if (otaSettlementForm) {
    otaSettlementForm.addEventListener("submit", submitOtaSettlement);
  }

  // Form submission
  bookingForm.addEventListener("submit", createBooking);
}

// Create a new booking
async function createBooking(event) {
  event.preventDefault();

  // Get form values
  const room = document.getElementById("booking-room").value;
  const guestName = document.getElementById("booking-guest-name").value;
  const guestMobile = document.getElementById("booking-guest-mobile").value;
  const checkInDate = document.getElementById("booking-check-in").value;
  const checkInTime = document.getElementById("booking-check-in-time").value; // Get the time
  const checkOutDate = document.getElementById("booking-check-out").value;
  const guestCount = parseInt(
    document.getElementById("booking-guest-count").value,
  );
  const notes = document.getElementById("booking-notes").value;
  const bookingSource = document.getElementById("booking-source")?.value || "normal";

  // AC toggle for rooms 200-206
  const acToggleEl = document.getElementById("booking-ac-toggle");
  const isAc = BOOKING_AC_ROOMS.includes(String(room)) && acToggleEl ? acToggleEl.checked : false;

  // Rate per night (for storage, used in bill calculation reference)
  const ratePerNight = parseInt(document.getElementById("booking-rate-per-night")?.value || 0) || null;

  // OTA vs normal fields (MMT and Agoda are both prepaid OTA sources)
  const isMmt = isOtaPrepaid(bookingSource);
  // For normal bookings, we recompute the total below from rate × nights as a
  // safety net (see "Submit-time recompute"). We still read the form value
  // here so the existing required-field validation works.
  let totalAmount = isMmt
    ? parseInt(document.getElementById("booking-ota-total")?.value || 0)
    : parseInt(document.getElementById("booking-total-amount").value);
  const partialPayment = isMmt ? 0 : parseInt(
    document.getElementById("booking-partial-payment").value || 0,
  );
  const paymentMethod = isMmt ? "ota" : document.getElementById("booking-payment-method").value;

  // OTA-specific fields
  const otaTotal = isMmt ? parseInt(document.getElementById("booking-ota-total")?.value || 0) : null;
  const otaCommission = isMmt ? parseFloat(document.getElementById("booking-ota-commission")?.value || 0) : null;
  const otaCommissionGst = isMmt ? parseFloat(document.getElementById("booking-ota-commission-gst")?.value || 0) : null;

  // Validation checks
  if (
    !room ||
    !guestName ||
    !guestMobile ||
    !checkInDate ||
    !checkInTime || // Validate time is present
    !checkOutDate ||
    !totalAmount
  ) {
    showNotification("Please fill all required fields", "error");
    return;
  }

  if (isMmt && !otaTotal) {
    showNotification("Please enter OTA total amount for prepaid OTA bookings", "error");
    return;
  }

  // Validate check-in date is not in the past
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const checkIn = new Date(checkInDate);
  checkIn.setHours(0, 0, 0, 0);

  if (checkIn < today) {
    showNotification("Check-in date cannot be in the past", "error");
    return;
  }

  // Validate check-out date is after check-in date
  const checkOut = new Date(checkOutDate);
  checkOut.setHours(0, 0, 0, 0);

  if (checkOut <= checkIn) {
    showNotification("Check-out date must be after check-in date", "error");
    return;
  }

  // ── Submit-time recompute (defence against stale form state) ───────────
  // Several user-reported bugs trace back to the form's `total_amount`
  // field being out of sync with `rate × nights`:
  //
  //   - operator picks a 3-night range, then edits the rate without the
  //     listener firing in the right order
  //   - flatpickr fires onChange twice during range selection and an
  //     intermediate state leaks into the total
  //   - operator types a manual total then changes dates without
  //     re-clicking the rate field
  //
  // We compute the authoritative `nights` from the validated dates above
  // and, for non-MMT bookings where a rate is known, force
  // `totalAmount = ratePerNight × nights`. If the operator deliberately
  // entered a discounted total (e.g. ₹100 off), we still honour it —
  // we only override when the mismatch can't be a deliberate discount
  // (i.e. it's exactly 1× the rate while nights > 1, the classic bug
  // signature).
  if (!isMmt) {
    const computedNights = Math.round(
      (checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (computedNights < 1) {
      showNotification(
        "Check-out must be at least one night after check-in.",
        "error",
      );
      return;
    }

    if (ratePerNight && ratePerNight > 0) {
      const expectedTotal = ratePerNight * computedNights;
      // Classic-bug signature: total equals one night's rate while the
      // stay is multi-night. Force-correct without prompting and let
      // the operator know what we changed.
      if (computedNights > 1 && totalAmount === ratePerNight) {
        totalAmount = expectedTotal;
        const totalEl = document.getElementById("booking-total-amount");
        if (totalEl) totalEl.value = expectedTotal;
        showNotification(
          "Total corrected: ₹" + ratePerNight + " × " + computedNights +
            " nights = ₹" + expectedTotal,
          "info",
        );
      } else if (totalAmount !== expectedTotal) {
        // Any other mismatch — could be a legitimate discount/markup.
        // Ask the operator before changing anything.
        const diff = expectedTotal - totalAmount;
        const direction = diff > 0 ? "less than" : "more than";
        const ok = window.confirm(
          "The total you entered (₹" + totalAmount + ") is " +
            Math.abs(diff) + " " + direction +
            " ₹" + ratePerNight + " × " + computedNights + " nights = ₹" +
            expectedTotal + ".\n\nClick OK to use the computed total (" +
            "₹" + expectedTotal + "), or Cancel to keep ₹" + totalAmount + ".",
        );
        if (ok) {
          totalAmount = expectedTotal;
          const totalEl = document.getElementById("booking-total-amount");
          if (totalEl) totalEl.value = expectedTotal;
        }
        // If not OK, totalAmount stays as the operator entered it.
      }
    }
  }

  // Disable submit button
  const submitBtn = event.target.querySelector("button[type=submit]");
  if (!submitBtn) return;

  const originalContent = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML =
    '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

  try {
    // Create booking data
    const bookingData = {
      room,
      guest_name: guestName,
      guest_mobile: guestMobile,
      check_in_date: checkInDate,
      check_in_time: checkInTime, // Include the time
      check_out_date: checkOutDate,
      total_amount: totalAmount,
      paid_amount: partialPayment,
      payment_method: paymentMethod,
      guest_count: guestCount,
      notes,
      photo_path: uploadedPhotoUrl,
      booking_source: bookingSource,
      is_ac: isAc,
      rate_per_night: ratePerNight,
    };

    // Add OTA fields for MMT
    if (isMmt) {
      bookingData.ota_total_amount = otaTotal;
      bookingData.ota_commission = otaCommission;
      bookingData.ota_commission_gst = otaCommissionGst;
      bookingData.net_receivable = otaTotal - otaCommission - otaCommissionGst;
    }

    console.log("Creating booking with data:", bookingData); // Debug log

    // Send request to create booking
    const response = await apiFetch("/create_booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookingData),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      // Close modal and refresh data
      const newBookingModal = document.getElementById("new-booking-modal");
      if (newBookingModal) {
        newBookingModal.classList.remove("show");
      }

      // Reset form
      event.target.reset();

      // Reset AC toggle + price fields
      const acContainer = document.getElementById("booking-ac-toggle-container");
      if (acContainer) acContainer.style.display = "none";
      const acToggleReset = document.getElementById("booking-ac-toggle");
      if (acToggleReset) acToggleReset.checked = false;
      const rateReset = document.getElementById("booking-rate-per-night");
      if (rateReset) rateReset.value = "";
      const nightsReset = document.getElementById("booking-nights-count");
      if (nightsReset) nightsReset.textContent = "0";

      // Reset photo
      uploadedPhotoUrl = null;
      const photoPreviewContainer = document.getElementById(
        "booking-photo-preview-container",
      );
      if (photoPreviewContainer) {
        photoPreviewContainer.style.display = "none";
      }

      // Show success notification
      showNotification("Booking created successfully!", "success");

      // Refresh bookings
      fetchBookings();

      // If we're in calendar view, refresh the calendar
      if (currentCalendarView === "calendar") {
        renderCalendar();
      }
    } else {
      showNotification(result.message || "Error creating booking", "error");
    }
  } catch (error) {
    console.error("Error creating booking:", error);
    showNotification(`Error creating booking: ${error.message}`, "error");
  } finally {
    // Re-enable submit button
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalContent;
  }
}

// ============================================================
// Multi-Room Booking — one submission, several linked room-bookings
// (shared dates/check-in-time, each room its own guest + price). See
// /create_multi_booking in routes/bookings.py for the backend side.
// ============================================================
var _mbPicker = null;

function initMultiBookingModal() {
  var modal = document.getElementById("multi-booking-modal");
  if (!modal) return;

  if (window.flatpickr && !_mbPicker) {
    _mbPicker = flatpickr("#mb-date-range", {
      mode: "range",
      dateFormat: "D, d M",
      minDate: "today",
      disableMobile: true,
      onChange: function (selectedDates) {
        function toYMD(d) {
          return (
            d.getFullYear() + "-" +
            String(d.getMonth() + 1).padStart(2, "0") + "-" +
            String(d.getDate()).padStart(2, "0")
          );
        }
        var ci = document.getElementById("mb-check-in");
        var co = document.getElementById("mb-check-out");
        if (selectedDates.length >= 1 && ci) ci.value = toYMD(selectedDates[0]);
        if (selectedDates.length === 2 && co) {
          co.value = toYMD(selectedDates[1]);
          refreshMultiBookingRoomOptions();
          updateAllMultiBookingRowRates();
        }
      },
    });
  }

  var addBtn = document.getElementById("mb-add-room-btn");
  if (addBtn) {
    addBtn.addEventListener("click", function () {
      addMultiBookingRoomRow();
    });
  }

  var sameGuestToggle = document.getElementById("mb-same-guest-toggle");
  if (sameGuestToggle) {
    sameGuestToggle.addEventListener("change", function () {
      setMultiBookingSameGuestMode(sameGuestToggle.checked);
    });
  }

  if (typeof attachMultiBookingMobileLookup === "function") {
    attachMultiBookingMobileLookup(
      document.getElementById("mb-shared-guest-mobile"),
      document.getElementById("mb-shared-guest-name"),
      document.getElementById("mb-shared-mobile-suggestions")
    );
  }

  document.querySelectorAll("#multi-booking-form .payment-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#multi-booking-form .payment-btn").forEach(function (b) {
        b.classList.remove("active");
      });
      this.classList.add("active");
      document.getElementById("mb-payment-method").value = this.dataset.payment;
    });
  });

  var closeBtn = modal.querySelector(".close-btn");
  if (closeBtn) {
    closeBtn.addEventListener("click", function () {
      modal.classList.remove("show");
    });
  }

  var form = document.getElementById("multi-booking-form");
  if (form) form.addEventListener("submit", submitMultiBooking);

  var container = document.getElementById("mb-rooms-container");
  if (container) {
    container.addEventListener("input", function (e) {
      if (e.target.classList.contains("mb-rate")) {
        updateMultiBookingRowTotal(e.target.closest(".mb-room-row"));
      }
      if (e.target.classList.contains("mb-guest-count")) {
        updateMultiBookingRowRate(e.target.closest(".mb-room-row"));
      }
      updateMultiBookingSummary();
    });
    container.addEventListener("change", function (e) {
      if (e.target.classList.contains("mb-room-select")) {
        refreshMultiBookingRoomOptions();
        updateMultiBookingRowRate(e.target.closest(".mb-room-row"));
      }
      if (e.target.classList.contains("mb-room-ac-toggle")) {
        updateMultiBookingRowRate(e.target.closest(".mb-room-row"));
      }
    });
    container.addEventListener("click", function (e) {
      var removeBtn = e.target.closest(".mb-remove-room-btn");
      if (removeBtn) removeMultiBookingRoomRow(removeBtn.closest(".mb-room-row"));
    });
  }

  // Booking type switch. Both booking modals carry an identical
  // .bk-mode-switch control; clicking the inactive side swaps modals. This
  // replaced the old "Switch to multi-room booking" text link.
  document.querySelectorAll(".bk-mode-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      setBookingMode(this.dataset.bookingMode);
    });
  });
}

// Reflect the current mode on every .bk-mode-switch on the page. Called by
// the two modal openers so the control is correct however the modal was
// opened (toolbar button, calendar day, or the switch itself).
function syncBookingModeButtons(mode) {
  document.querySelectorAll(".bk-mode-btn").forEach(function (btn) {
    var on = btn.dataset.bookingMode === mode;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
}

// Show the booking modal for `mode` ("single" | "multi") and hide the other.
// Each opener resets its own form, so switching always starts clean. That is
// deliberate: the two forms collect different fields (the multi form has no
// OTA commission block, the single form has no per-room rows), and silently
// carrying half the values across would be worse than re-entering them.
function setBookingMode(mode) {
  var single = document.getElementById("new-booking-modal");
  var multi = document.getElementById("multi-booking-modal");
  if (mode === "multi") {
    if (single) single.classList.remove("show");
    openMultiBookingModal();
  } else {
    if (multi) multi.classList.remove("show");
    showNewBookingModal();
  }
}

function multiBookingRoomRowHtml() {
  return (
    '<div class="mb-room-row">' +
      '<div class="mb-room-row-head">' +
        '<span class="mb-room-badge"><span class="mb-room-num">1</span> Room</span>' +
        '<button type="button" class="mb-remove-room-btn" title="Remove this room">' +
          '<i class="fas fa-times"></i>' +
        '</button>' +
      '</div>' +
      '<div class="bk-row">' +
        '<div class="form-group">' +
          '<label class="form-label">Room</label>' +
          '<select class="form-control mb-room-select" required><option value="">Select dates first</option></select>' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label"># Guests</label>' +
          '<input type="number" class="form-control mb-guest-count" value="1" min="1" />' +
        '</div>' +
      '</div>' +
      '<div class="bk-row mb-room-guest-fields">' +
        '<div class="form-group">' +
          '<label class="form-label">Guest Name</label>' +
          '<input type="text" class="form-control mb-guest-name" placeholder="Full name" required autocomplete="off" />' +
        '</div>' +
        '<div class="form-group" style="position:relative;">' +
          '<label class="form-label">Mobile</label>' +
          '<input type="tel" class="form-control mb-guest-mobile" placeholder="10-digit mobile" required pattern="[0-9]{10}" autocomplete="off" />' +
          '<div class="mb-mobile-suggestions" style="display:none;"></div>' +
        '</div>' +
      '</div>' +
      '<div class="mb-room-ac-row" style="display:none;align-items:center;justify-content:space-between;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:0.4rem 0.6rem;margin-bottom:0.5rem;font-size:0.78rem;">' +
        '<span style="color:#0284c7;font-weight:600;"><i class="fas fa-snowflake"></i> AC Room</span>' +
        '<label style="display:flex;align-items:center;gap:0.35rem;cursor:pointer;margin:0;">' +
          '<input type="checkbox" class="mb-room-ac-toggle" style="width:15px;height:15px;accent-color:#0ea5e9;" />' +
          '<span style="font-size:0.76rem;color:#64748b;">+₹600/night</span>' +
        '</label>' +
      '</div>' +
      '<div class="bk-row">' +
        '<div class="form-group">' +
          '<label class="form-label">Rate/Night (₹)</label>' +
          '<input type="number" class="form-control mb-rate" placeholder="Rate" min="0" />' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label">Total Amount (₹)</label>' +
          '<input type="number" class="form-control mb-total" placeholder="Total" min="0" required />' +
        '</div>' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:0;">' +
        '<label class="form-label">Advance (₹)</label>' +
        '<input type="number" class="form-control mb-advance" placeholder="Optional" min="0" value="0" />' +
      '</div>' +
    '</div>'
  );
}

// Keep each row's "Room N" badge in sync with its position — rows can be
// added/removed in any order, so this just renumbers left to right.
function renumberMultiBookingRooms() {
  document.querySelectorAll("#mb-rooms-container .mb-room-row").forEach(function (row, i) {
    var num = row.querySelector(".mb-room-num");
    if (num) num.textContent = i + 1;
  });
}

function addMultiBookingRoomRow() {
  var container = document.getElementById("mb-rooms-container");
  if (!container) return;
  var wrap = document.createElement("div");
  wrap.innerHTML = multiBookingRoomRowHtml();
  var row = wrap.firstElementChild;
  var sameGuestToggle = document.getElementById("mb-same-guest-toggle");
  if (sameGuestToggle && sameGuestToggle.checked) {
    row.classList.add("mb-same-guest");
    row.querySelector(".mb-guest-name").required = false;
    row.querySelector(".mb-guest-mobile").required = false;
  }
  container.appendChild(row);
  renumberMultiBookingRooms();
  refreshMultiBookingRoomOptions();

  if (typeof attachMultiBookingMobileLookup === "function") {
    attachMultiBookingMobileLookup(
      row.querySelector(".mb-guest-mobile"),
      row.querySelector(".mb-guest-name"),
      row.querySelector(".mb-mobile-suggestions")
    );
  }
}

function removeMultiBookingRoomRow(rowEl) {
  var container = document.getElementById("mb-rooms-container");
  if (!container || !rowEl) return;
  if (container.children.length <= 1) {
    showNotification("A multi-room booking needs at least one room left — close this modal instead if you want none.", "warning");
    return;
  }
  rowEl.remove();
  renumberMultiBookingRooms();
  refreshMultiBookingRoomOptions();
  updateMultiBookingSummary();
}

// "Use the same guest for every room" toggle: hides each row's own
// Guest Name / Mobile fields in favour of one shared pair up top, and
// keeps HTML5 `required` pointed at whichever fields are actually
// visible so the browser doesn't block submission on a hidden field.
function setMultiBookingSameGuestMode(isSame) {
  var sharedFields = document.getElementById("mb-shared-guest-fields");
  var sharedName = document.getElementById("mb-shared-guest-name");
  var sharedMobile = document.getElementById("mb-shared-guest-mobile");
  if (sharedFields) sharedFields.classList.toggle("show", isSame);
  if (sharedName) sharedName.required = isSame;
  if (sharedMobile) sharedMobile.required = isSame;

  document.querySelectorAll("#mb-rooms-container .mb-room-row").forEach(function (row) {
    row.classList.toggle("mb-same-guest", isSame);
    var nameEl = row.querySelector(".mb-guest-name");
    var mobileEl = row.querySelector(".mb-guest-mobile");
    if (nameEl) nameEl.required = !isSame;
    if (mobileEl) mobileEl.required = !isSame;
  });
}

// Rate × nights auto-fill, same idea as the single-room form's calc —
// only while the operator is actively typing in the rate field, so it
// never clobbers a manually-entered total.
function updateMultiBookingRowTotal(rowEl) {
  if (!rowEl) return;
  var rateEl = rowEl.querySelector(".mb-rate");
  var totalEl = rowEl.querySelector(".mb-total");
  var ci = document.getElementById("mb-check-in").value;
  var co = document.getElementById("mb-check-out").value;
  if (!rateEl || !totalEl || !ci || !co) return;
  if (document.activeElement !== rateEl) return;
  var rate = parseInt(rateEl.value || 0);
  if (!rate) return;
  var nights = Math.round((new Date(co) - new Date(ci)) / 86400000);
  if (nights > 0) totalEl.value = rate * nights;
}

// Auto-fills Rate/Night + Total for a room row from its room number and
// guest count, reusing the same per-room pricing table the regular
// booking form uses (getBookingRatePerNight, defined above). Fires when
// the room, guest count, AC toggle, or the shared dates change — NOT on
// every keystroke in the rate field itself, so a manually-typed rate
// (handled by updateMultiBookingRowTotal above) is never overwritten
// mid-edit.
function updateMultiBookingRowRate(rowEl) {
  if (!rowEl) return;
  var roomSelect = rowEl.querySelector(".mb-room-select");
  var guestCountEl = rowEl.querySelector(".mb-guest-count");
  var rateEl = rowEl.querySelector(".mb-rate");
  var totalEl = rowEl.querySelector(".mb-total");
  var acRow = rowEl.querySelector(".mb-room-ac-row");
  var acToggle = rowEl.querySelector(".mb-room-ac-toggle");
  if (!roomSelect || !rateEl || !totalEl) return;

  var room = roomSelect.value;
  if (!room) {
    if (acRow) acRow.style.display = "none";
    return;
  }

  var isAcRoom = ["200", "201", "202", "203", "204", "205", "206"].indexOf(String(room)) !== -1;
  if (acRow) acRow.style.display = isAcRoom ? "flex" : "none";
  if (!isAcRoom && acToggle) acToggle.checked = false;

  var ci = document.getElementById("mb-check-in").value;
  var co = document.getElementById("mb-check-out").value;
  if (!ci || !co) return;
  var nights = Math.round((new Date(co) - new Date(ci)) / 86400000);
  if (nights <= 0) return;

  var guests = parseInt((guestCountEl && guestCountEl.value) || 1) || 1;
  var rate = typeof getBookingRatePerNight === "function" ? getBookingRatePerNight(room, guests) : 0;
  if (isAcRoom && acToggle && acToggle.checked) rate += 600;

  rateEl.value = rate;
  totalEl.value = rate * nights;
  updateMultiBookingSummary();
}

function updateAllMultiBookingRowRates() {
  document.querySelectorAll("#mb-rooms-container .mb-room-row").forEach(updateMultiBookingRowRate);
}

function updateMultiBookingSummary() {
  var rows = document.querySelectorAll("#mb-rooms-container .mb-room-row");
  var grandTotal = 0, grandAdvance = 0;
  rows.forEach(function (row) {
    grandTotal += parseInt(row.querySelector(".mb-total").value || 0);
    grandAdvance += parseInt(row.querySelector(".mb-advance").value || 0);
  });
  var totalEl = document.getElementById("mb-grand-total");
  var advEl = document.getElementById("mb-grand-advance");
  var countEl = document.getElementById("mb-grand-room-count");
  if (totalEl) totalEl.textContent = "₹" + grandTotal;
  if (advEl) advEl.textContent = "₹" + grandAdvance;
  if (countEl) countEl.textContent = rows.length;
}

// Re-fetch availability for the shared dates and repopulate every room
// row's dropdown, excluding rooms already picked in OTHER rows so the
// same room can't be selected twice in one submission.
async function refreshMultiBookingRoomOptions() {
  var ci = document.getElementById("mb-check-in").value;
  var co = document.getElementById("mb-check-out").value;
  var rows = document.querySelectorAll("#mb-rooms-container .mb-room-row");
  if (!ci || !co || !rows.length) return;

  try {
    const response = await apiFetch("/check_availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ check_in_date: ci, check_out_date: co }),
    });
    const result = await response.json();
    if (!result.success) {
      showNotification(result.message || "Error checking availability", "error");
      return;
    }
    var available = result.available_rooms || [];
    var chosen = Array.prototype.map.call(rows, function (r) {
      return r.querySelector(".mb-room-select").value;
    }).filter(Boolean);

    rows.forEach(function (row) {
      var select = row.querySelector(".mb-room-select");
      var current = select.value;
      var options = available.filter(function (room) {
        return room === current || chosen.indexOf(room) === -1;
      });
      select.innerHTML =
        '<option value="">Select a room</option>' +
        options
          .map(function (room) {
            return (
              '<option value="' + room + '"' +
              (room === current ? " selected" : "") +
              ">Room " + room + "</option>"
            );
          })
          .join("");
    });
  } catch (error) {
    console.error("Error checking availability for multi-room booking:", error);
  }
}

function openMultiBookingModal() {
  var modal = document.getElementById("multi-booking-modal");
  if (!modal) return;

  var form = document.getElementById("multi-booking-form");
  if (form) form.reset();
  setMultiBookingSameGuestMode(false);

  document.querySelectorAll("#multi-booking-form .payment-btn").forEach(function (btn) {
    btn.classList.remove("active");
  });
  var mbCashBtn = document.querySelector("#multi-booking-form .payment-btn.cash");
  if (mbCashBtn) mbCashBtn.classList.add("active");
  var mbPaymentMethodInput = document.getElementById("mb-payment-method");
  if (mbPaymentMethodInput) mbPaymentMethodInput.value = "cash";

  var container = document.getElementById("mb-rooms-container");
  if (container) container.innerHTML = "";
  addMultiBookingRoomRow();
  addMultiBookingRoomRow();

  if (_mbPicker) _mbPicker.clear();
  var ci = document.getElementById("mb-check-in");
  var co = document.getElementById("mb-check-out");
  if (ci) ci.value = "";
  if (co) co.value = "";

  var timeInput = document.getElementById("mb-check-in-time");
  if (timeInput) timeInput.value = "14:00";

  updateMultiBookingSummary();
  syncBookingModeButtons("multi");
  modal.classList.add("show");
}

async function submitMultiBooking(event) {
  event.preventDefault();

  var checkInDate = document.getElementById("mb-check-in").value;
  var checkOutDate = document.getElementById("mb-check-out").value;
  var checkInTime = document.getElementById("mb-check-in-time").value;
  var bookingSource = document.getElementById("mb-source").value;
  var paymentMethod = document.getElementById("mb-payment-method").value;
  var notes = document.getElementById("mb-notes").value;

  if (!checkInDate || !checkOutDate || !checkInTime) {
    showNotification("Please select check-in/check-out dates and a check-in time", "error");
    return;
  }

  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var checkIn = new Date(checkInDate);
  checkIn.setHours(0, 0, 0, 0);
  if (checkIn < today) {
    showNotification("Check-in date cannot be in the past", "error");
    return;
  }
  var checkOut = new Date(checkOutDate);
  checkOut.setHours(0, 0, 0, 0);
  if (checkOut <= checkIn) {
    showNotification("Check-out date must be after check-in date", "error");
    return;
  }

  var rows = document.querySelectorAll("#mb-rooms-container .mb-room-row");
  if (rows.length < 2) {
    showNotification("Add at least 2 rooms — for a single room, use the regular New Booking form", "error");
    return;
  }

  var sameGuestToggle = document.getElementById("mb-same-guest-toggle");
  var useSameGuest = !!(sameGuestToggle && sameGuestToggle.checked);
  var sharedGuestName = document.getElementById("mb-shared-guest-name").value.trim();
  var sharedGuestMobile = document.getElementById("mb-shared-guest-mobile").value.trim();

  if (useSameGuest) {
    if (!sharedGuestName || !sharedGuestMobile) {
      showNotification("Enter the shared guest's name and mobile", "error");
      return;
    }
    if (!/^[0-9]{10}$/.test(sharedGuestMobile)) {
      showNotification("Shared guest mobile must be 10 digits", "error");
      return;
    }
  }

  var roomsPayload = [];
  var seenRooms = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var room = row.querySelector(".mb-room-select").value;
    var guestName = useSameGuest ? sharedGuestName : row.querySelector(".mb-guest-name").value.trim();
    var guestMobile = useSameGuest ? sharedGuestMobile : row.querySelector(".mb-guest-mobile").value.trim();
    var totalAmount = parseInt(row.querySelector(".mb-total").value || 0);
    var advance = parseInt(row.querySelector(".mb-advance").value || 0);
    var rate = parseInt(row.querySelector(".mb-rate").value || 0) || null;
    var guestCount = parseInt(row.querySelector(".mb-guest-count").value || 1);

    if (!room || !guestName || !guestMobile || !totalAmount) {
      showNotification("Room #" + (i + 1) + ": fill in room, guest name, mobile and total amount", "error");
      return;
    }
    if (!/^[0-9]{10}$/.test(guestMobile)) {
      showNotification("Room #" + (i + 1) + ": mobile must be 10 digits", "error");
      return;
    }
    if (advance > totalAmount) {
      showNotification("Room " + room + ": advance can't exceed the total amount", "error");
      return;
    }
    if (seenRooms[room]) {
      showNotification("Room " + room + " is selected more than once", "error");
      return;
    }
    seenRooms[room] = true;

    roomsPayload.push({
      room: room,
      guest_name: guestName,
      guest_mobile: guestMobile,
      guest_count: guestCount,
      rate_per_night: rate,
      total_amount: totalAmount,
      advance: advance,
    });
  }

  var submitBtn = event.target.querySelector("button[type=submit]");
  var originalContent = submitBtn ? submitBtn.innerHTML : "";
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';
  }

  try {
    const response = await apiFetch("/create_multi_booking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        check_in_date: checkInDate,
        check_in_time: checkInTime,
        check_out_date: checkOutDate,
        booking_source: bookingSource,
        payment_method: paymentMethod,
        notes: notes,
        rooms: roomsPayload,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      document.getElementById("multi-booking-modal").classList.remove("show");
      showNotification(result.message || "Bookings created successfully!", "success");
      fetchBookings();
      if (currentCalendarView === "calendar") renderCalendar();
    } else {
      showNotification(result.message || "Error creating bookings", "error");
    }
  } catch (error) {
    console.error("Error creating multi-room booking:", error);
    showNotification("Error creating bookings: " + error.message, "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalContent;
    }
  }
}

document.addEventListener("DOMContentLoaded", initMultiBookingModal);

// Trigger one ingestion pass for a single OTA endpoint. Returns a normalised
// {ok, created, settled, skipped, review, message} result; never throws.
async function _ingestOta(label, endpoint) {
  try {
    const response = await apiFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success === false) {
      throw new Error(result.message || `HTTP ${response.status}`);
    }
    return {
      label,
      ok: true,
      created: result.created || 0,
      settled: result.settled || 0,
      skipped: result.skipped_existing || 0,
      review: result.needs_review || 0,
    };
  } catch (error) {
    console.error(`Error fetching from ${label}:`, error);
    return { label, ok: false, message: error.message };
  }
}

// Manually fetch new bookings from BOTH OTA inboxes (MMT + Agoda) in one
// click, then refresh the list. Uses the logged-in user's auth (apiFetch
// attaches the Firebase token), so no ingest secret is needed from the browser.
// The two passes run in parallel and are reported together; a failure in one
// does not abort the other.
async function fetchFromMmt() {
  const btn = document.getElementById("fetch-mmt-btn");
  const original = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> Fetching...';
  }
  try {
    // 1) Pull new bookings from both OTA inboxes in parallel.
    const otaResults = await Promise.all([
      _ingestOta("MMT", "/mmt/ingest"),
      _ingestOta("Agoda", "/agoda/ingest"),
    ]);
    // 2) Then reconcile bank payment-advice settlements — runs AFTER booking
    //    ingest so a just-created booking can be matched in the same click.
    const bankResult = await _ingestOta("Settlements", "/bank/settlements/ingest");
    const results = [...otaResults, bankResult];

    const totalCreated = results.reduce((s, r) => s + (r.created || 0), 0);
    const totalSettled = results.reduce((s, r) => s + (r.settled || 0), 0);
    const totalReview = results.reduce((s, r) => s + (r.review || 0), 0);
    const totalSkipped = results.reduce((s, r) => s + (r.skipped || 0), 0);
    const failures = results.filter((r) => !r.ok);

    // Per-source detail for the toast, e.g. "MMT: 2 new · Agoda: 1 new".
    const parts = results
      .filter((r) => r.ok && (r.created > 0 || r.settled > 0))
      .map((r) => {
        let s = `${r.label}: `;
        const bits = [];
        if (r.created > 0) bits.push(`${r.created} new`);
        if (r.settled > 0) bits.push(`${r.settled} settled`);
        return s + bits.join(", ");
      });

    if (totalCreated > 0 || totalSettled > 0) {
      let msg = parts.join(" · ");
      if (totalReview > 0) msg += ` (${totalReview} need review)`;
      showNotification(msg, "success");
    } else if (failures.length === results.length) {
      // Everything failed — surface the first error.
      showNotification(`Fetch failed: ${failures[0].message}`, "error");
    } else if (failures.length > 0) {
      showNotification(
        `${failures.map((f) => f.label).join(", ")} fetch failed; others up to date`,
        "error",
      );
    } else {
      showNotification(
        totalSkipped > 0
          ? "No new bookings (already up to date)"
          : "No new emails found",
        "info",
      );
    }

    // Reload the bookings list so newly-created ones appear.
    await fetchBookings();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }
}

// Fetch all bookings
async function fetchBookings() {
  try {
    const response = await apiFetch("/get_bookings");
    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      bookings = result.bookings;
      renderBookings();
    } else {
      showNotification(result.message || "Error fetching bookings", "error");
    }
  } catch (error) {
    console.error("Error fetching bookings:", error);
    showNotification(`Error fetching bookings: ${error.message}`, "error");
  }
}

// Render bookings based on filter
function renderBookings() {
  const bookingsList = document.getElementById("bookings-list");
  if (!bookingsList) return;

  // Apply filter
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  filteredBookings = bookings.filter((booking) => {
    if (
      booking.status === "cancelled" &&
      currentBookingFilter !== "cancelled"
    ) {
      return false;
    }

    if (
      booking.status === "checked_in" &&
      currentBookingFilter !== "completed"
    ) {
      return false;
    }

    // For upcoming filter, only show confirmed bookings with future check-in
    if (currentBookingFilter === "upcoming") {
      const checkInDate = new Date(booking.check_in_date);
      return booking.status === "confirmed" && checkInDate >= today;
    }

    // For today filter, show confirmed bookings with today's check-in
    if (currentBookingFilter === "today") {
      const checkInDate = new Date(booking.check_in_date);
      checkInDate.setHours(0, 0, 0, 0);
      return (
        booking.status === "confirmed" &&
        checkInDate.getTime() === today.getTime()
      );
    }

    // For all filter, show all bookings regardless of status
    return true;
  });

  // Sort bookings by check-in date AND time
  filteredBookings.sort((a, b) => {
    const dateA = new Date(a.check_in_date);
    const dateB = new Date(b.check_in_date);

    if (
      currentBookingFilter === "completed" ||
      currentBookingFilter === "cancelled"
    ) {
      // Most recent first for past bookings
      if (dateB.getTime() !== dateA.getTime()) {
        return dateB - dateA;
      }
      // If same date, sort by time (most recent first)
      const timeA = a.check_in_time || "23:59";
      const timeB = b.check_in_time || "23:59";
      return timeB.localeCompare(timeA);
    } else {
      // Soonest first for upcoming bookings
      if (dateA.getTime() !== dateB.getTime()) {
        return dateA - dateB;
      }
      // If same date, sort by time (earliest first)
      const timeA = a.check_in_time || "00:00";
      const timeB = b.check_in_time || "00:00";
      return timeA.localeCompare(timeB);
    }
  });

  // Show empty state if no bookings
  if (filteredBookings.length === 0) {
    bookingsList.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-calendar-alt fa-3x"></i>
        <p>No ${currentBookingFilter} bookings found</p>
      </div>
    `;
    return;
  }

  // Render bookings
  let html = "";
  const groupIndex = buildBookingGroupIndex();

  filteredBookings.forEach((booking) => {
    // Format dates for display
    const checkInDate = new Date(booking.check_in_date);
    const checkOutDate = new Date(booking.check_out_date);
    const formattedCheckIn = formatDate(checkInDate);
    const formattedCheckOut = formatDate(checkOutDate);

    // Format check-in time - ALWAYS SHOW IT
    const checkInTime = booking.check_in_time || "14:00"; // Default to 2 PM if not set
    const formattedTime = formatTime(checkInTime);

    // Calculate nights
    const nights = Math.round(
      (checkOutDate - checkInDate) / (1000 * 60 * 60 * 24),
    );

    // Determine status badge color
    let statusBadge = "";
    switch (booking.status) {
      case "confirmed":
        statusBadge = '<span class="status-badge confirmed">Confirmed</span>';
        break;
      case "cancelled":
        statusBadge = '<span class="status-badge cancelled">Cancelled</span>';
        break;
      case "checked_in":
        statusBadge = '<span class="status-badge checked-in">Checked In</span>';
        break;
      default:
        statusBadge = '<span class="status-badge">Unknown</span>';
    }

    // Determine if check-in is today
    const isToday =
      checkInDate.toISOString().split("T")[0] ===
      new Date().toISOString().split("T")[0];
    const todayBadge = isToday ? '<span class="today-badge">Today</span>' : "";

    // Calculate payment status
    const paymentStatus =
      booking.paid_amount === booking.total_amount
        ? '<span class="payment-badge paid">Fully Paid</span>'
        : booking.paid_amount > 0
          ? '<span class="payment-badge partial">Partially Paid</span>'
          : '<span class="payment-badge unpaid">Unpaid</span>';

    // Booking source badge
    const src = booking.booking_source || "normal";
    let sourceBadge = "";
    if (src === "mmt") {
      sourceBadge = '<span class="booking-source-badge src-mmt"><i class="fas fa-globe"></i> MMT</span>';
    } else if (src === "agoda") {
      sourceBadge = '<span class="booking-source-badge src-agoda"><i class="fas fa-globe"></i> Agoda</span>';
    } else if (src === "booking.com") {
      sourceBadge = '<span class="booking-source-badge src-bookingcom"><i class="fas fa-globe"></i> Booking.com</span>';
    }
    // Normal bookings: no badge (keeps UI clean)

    // AC badge for rooms 200-206
    const acBadge = booking.is_ac
      ? '<span class="booking-source-badge" style="background:linear-gradient(135deg,#e0f2fe,#bae6fd);color:#0369a1;border:1px solid #7dd3fc;">❄️ AC</span>'
      : "";

    // Multi-room group chip — tells the manager at a glance that this room
    // travels with others (same dates, one group_booking_id).
    const groupSize = booking.group_booking_id
      ? (groupIndex.get(booking.group_booking_id) || []).length
      : 0;
    const groupChip =
      groupSize > 1
        ? `<span class="bk-group-chip"><i class="fas fa-layer-group"></i> Group · ${groupSize}</span>`
        : "";

    // Card accent: cancelled / checked-in / arriving today.
    let stateClass = "";
    if (booking.status === "cancelled") stateClass = "bk-cancelled";
    else if (booking.status === "checked_in") stateClass = "bk-checked-in";
    else if (isToday) stateClass = "bk-arriving-today";

    const balance = booking.balance != null
      ? booking.balance
      : (booking.total_amount || 0) - (booking.paid_amount || 0);
    const balanceNote =
      !isOtaPrepaid(src) && balance > 0
        ? `<span class="bk-balance-note">₹${balance} due</span>`
        : "";

    html += `
      <div class="booking-item ${stateClass}" data-id="${booking.booking_id}"
           role="button" tabindex="0">
        <div class="booking-header">
          <div class="booking-room">Room ${booking.room}${booking.is_ac ? ' <span style="font-size:0.7rem;color:#0ea5e9;">❄️</span>' : ''}</div>
          <div class="booking-badges">
            ${statusBadge}
            ${todayBadge}
            ${groupChip}
            ${acBadge}
            ${sourceBadge}
          </div>
        </div>
        <div class="booking-guest">${booking.guest_name}</div>
        <div class="bk-stay-line">
          <i class="fas fa-calendar-check"></i> ${formattedCheckIn}
          <span class="bk-stay-sep">&rarr;</span> ${formattedCheckOut}
          <span class="bk-stay-sep">&middot;</span> ${nights} night${nights !== 1 ? "s" : ""}
          <span class="bk-stay-time"><i class="fas fa-clock"></i> ${formattedTime}</span>
        </div>
        <div class="booking-footer">
          <div class="booking-payment">
            ${paymentStatus}
            ${balanceNote}
          </div>
          <div class="booking-amount">${isOtaPrepaid(src) ? "OTA" : "₹" + booking.total_amount}</div>
        </div>
      </div>
    `;
  });

  bookingsList.innerHTML = html;

  // The whole card is the tap target (the old eye-icon button was a 32px
  // target on a 300px card). Keyboard access via role=button + Enter/Space.
  bookingsList.querySelectorAll(".booking-item").forEach((card) => {
    const open = () => showBookingDetails(card.dataset.id);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });
}

// ── Multi-room booking groups ───────────────────────────────────────────────
// Bookings created through the multi-room flow each get their own document
// but share a group_booking_id (see /create_multi_booking in
// routes/bookings.py). Cancelled rooms are excluded — a cancelled room must
// not appear on a confirmation or arrivals sheet.
function buildBookingGroupIndex(source) {
  const index = new Map();
  (source || bookings).forEach((b) => {
    if (!b.group_booking_id || b.status === "cancelled") return;
    if (!index.has(b.group_booking_id)) index.set(b.group_booking_id, []);
    index.get(b.group_booking_id).push(b);
  });
  index.forEach((list) =>
    list.sort((a, b) => String(a.room).localeCompare(String(b.room), undefined, { numeric: true })),
  );
  return index;
}

// Every non-cancelled room that shares this booking's group. Returns [booking]
// for a plain single-room booking, so callers never need to special-case it.
function getBookingGroupMembers(booking) {
  if (!booking || !booking.group_booking_id || booking.status === "cancelled") {
    return booking ? [booking] : [];
  }
  const members = buildBookingGroupIndex().get(booking.group_booking_id) || [];
  return members.length ? members : [booking];
}

// Helper function to format time
function formatTime(timeStr) {
  if (!timeStr) return "2:00 PM"; // Default display

  // timeStr is in HH:MM format
  const [hours, minutes] = timeStr.split(":");
  const hour = parseInt(hours);
  const ampm = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;

  return `${displayHour}:${minutes} ${ampm}`;
}

// Format date for display
function formatDate(date) {
  const options = {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  };
  return date.toLocaleDateString("en-US", options);
}

// Format date-time for display
function formatDateTime(dateStr) {
  if (!dateStr) return "N/A";

  const date = new Date(dateStr);
  const options = {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  };

  return date.toLocaleDateString("en-US", options);
}

// Show booking details modal - Updated
function showBookingDetails(bookingId) {
  const booking = bookings.find((b) => b.booking_id === bookingId);
  if (!booking) return;

  // Store for WhatsApp and other actions
  _activeBookingForWhatsApp = booking;

  const detailsModal = document.getElementById("booking-details-modal");
  if (!detailsModal) return;

  // Calculate stay duration
  const checkInDate = new Date(booking.check_in_date);
  const checkOutDate = new Date(booking.check_out_date);
  const nights = Math.round(
    (checkOutDate - checkInDate) / (1000 * 60 * 60 * 24),
  );

  // Format dates
  const formattedCheckIn = formatDate(checkInDate);
  const formattedCheckOut = formatDate(checkOutDate);
  const bookingDate = formatDateTime(booking.booking_date);

  // Format check-in time with default
  const checkInTime = booking.check_in_time || "14:00";
  const formattedTime = formatTime(checkInTime);

  // Set booking details
  document.getElementById("details-booking-id").textContent = bookingId;
  // Room number with AC indicator in details modal
  const roomEl = document.getElementById("details-room-number");
  if (roomEl) {
    roomEl.innerHTML = booking.is_ac
      ? `${booking.room} <span style="font-size:0.7rem;background:#e0f2fe;color:#0369a1;border:1px solid #7dd3fc;border-radius:10px;padding:1px 6px;font-weight:600;">❄️ AC</span>`
      : booking.room;
  }
  document.getElementById("details-guest-name").textContent = booking.guest_name;
  document.getElementById("details-guest-mobile").textContent = booking.guest_mobile;
  document.getElementById("details-guest-mobile-link").href = `tel:${booking.guest_mobile}`;
  document.getElementById("details-check-in").textContent = formattedCheckIn;
  document.getElementById("details-check-in-time").textContent = `Expected at ${formattedTime}`;
  document.getElementById("details-check-out").textContent = formattedCheckOut;
  document.getElementById("details-booking-date").textContent = bookingDate;
  document.getElementById("details-nights").textContent = `${nights} night${nights !== 1 ? "s" : ""}`;
  document.getElementById("details-guests").textContent = `${booking.guest_count || 1} guest${(booking.guest_count || 1) !== 1 ? "s" : ""}`;
  document.getElementById("details-notes").textContent = booking.notes || "—";

  // ── Attribution: "Booked by ..." inline near the booking date ───────────
  // Idempotent — re-uses the same span on re-opens.
  if (window.CibaraUsers) {
    const dateEl = document.getElementById("details-booking-date");
    if (dateEl) {
      let attrEl = document.getElementById("details-booked-by");
      if (!attrEl) {
        attrEl = document.createElement("span");
        attrEl.id = "details-booked-by";
        attrEl.style.cssText =
          "margin-left:8px;font-size:11px;color:#6b7280;";
        dateEl.parentElement && dateEl.parentElement.appendChild(attrEl);
      }
      const who = booking.bookedBy || booking.createdBy;
      if (who) {
        attrEl.innerHTML = "by <strong style=\"color:#1e293b\">" +
          (function (s) { return String(s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
          }); })(window.CibaraUsers.nameOf(who)) +
          "</strong>";
        attrEl.style.display = "";
      } else {
        attrEl.style.display = "none";
      }
    }
  }

  // Status badge
  const statusEl = document.getElementById("details-status");
  if (statusEl) {
    const statusLabels = { confirmed: "Confirmed", checked_in: "Checked In", cancelled: "Cancelled" };
    const statusColors = { confirmed: "var(--primary)", checked_in: "var(--success)", cancelled: "var(--danger)" };
    const s = booking.status;
    statusEl.innerHTML = `<span style="background:${statusColors[s] || "var(--gray)"};color:#fff;font-size:0.7rem;font-weight:600;padding:2px 8px;border-radius:12px;">${statusLabels[s] || s}</span>`;
  }

  // Display photo if available
  const photoContainer = document.getElementById("details-photo-container");
  if (photoContainer) {
    if (booking.photo_path) {
      const photoImg = document.getElementById("details-guest-photo");
      if (photoImg) photoImg.src = booking.photo_path;
      photoContainer.style.display = "block";
    } else {
      photoContainer.style.display = "none";
    }
  }

  // ── Multi-room group banner + WhatsApp button label ─────────────────────
  // A room booked through the multi-room flow shares a group_booking_id with
  // its siblings. Surfacing that here is what makes the single combined
  // WhatsApp confirmation predictable: the manager can see it will cover all
  // the listed rooms before pressing WA.
  const groupMembers = getBookingGroupMembers(booking);
  const isGroup = groupMembers.length > 1;
  const groupBanner = document.getElementById("details-group-banner");
  if (groupBanner) {
    if (isGroup) {
      const escRoom = (s) =>
        String(s).replace(/[&<>"']/g, (c) => ({
          "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        })[c]);
      const groupTotal = groupMembers.reduce((s, m) => s + (m.total_amount || 0), 0);
      groupBanner.innerHTML =
        `<div><i class="fas fa-layer-group"></i> Part of a <strong>${groupMembers.length}-room booking</strong>` +
        ` · ₹${groupTotal} total</div>` +
        `<div class="bk-group-rooms">` +
        groupMembers
          .map(
            (m) =>
              `<span class="bk-group-room${m.booking_id === bookingId ? " bk-group-room-current" : ""}">` +
              `Room ${escRoom(m.room)}</span>`,
          )
          .join("") +
        `</div>` +
        `<div style="margin-top:0.35rem;font-size:0.74rem;opacity:0.85;">` +
        `WhatsApp sends one combined confirmation for all ${groupMembers.length} rooms.</div>`;
      groupBanner.style.display = "";
    } else {
      groupBanner.style.display = "none";
      groupBanner.innerHTML = "";
    }
  }
  const waBtnLabel = document.querySelector("#send-whatsapp-btn span");
  if (waBtnLabel) waBtnLabel.textContent = isGroup ? `WA ×${groupMembers.length}` : "WA";

  // For OTA prepaid (MMT / Agoda): hide the payment section (no money
  // collected from the guest at the hotel).
  const isMmt = isOtaPrepaid(booking.booking_source);
  const paymentSection = document.getElementById("details-payment-section");
  if (paymentSection) paymentSection.style.display = isMmt ? "none" : "";

  // Normal bookings: populate payment fields
  if (!isMmt) {
    document.getElementById("details-total-amount").textContent = `₹${booking.total_amount}`;
    document.getElementById("details-paid-amount").textContent = `₹${booking.paid_amount}`;
    document.getElementById("details-balance").textContent = `₹${booking.balance}`;
  }

  // OTA Section
  const otaSection = document.getElementById("details-ota-section");
  if (otaSection) {
    if (isMmt) {
      otaSection.style.display = "block";
      const srcEl = document.getElementById("details-booking-source");
      if (srcEl) srcEl.textContent = otaSourceLabel(booking.booking_source) + " Prepaid";
      const otaTotalEl = document.getElementById("details-ota-total");
      const otaCommEl  = document.getElementById("details-ota-commission");
      const netRecvEl  = document.getElementById("details-net-receivable");
      const settlStatusEl = document.getElementById("details-settlement-status");
      if (otaTotalEl) otaTotalEl.textContent = "₹" + (booking.ota_total_amount || 0);
      if (otaCommEl)  otaCommEl.textContent  = "₹" + ((booking.ota_commission || 0) + (booking.ota_commission_gst || 0));
      if (netRecvEl)  netRecvEl.textContent  = "₹" + (booking.net_receivable || 0);
      if (settlStatusEl) {
        const received = booking.settlement_status === "received";
        settlStatusEl.innerHTML = received
          ? '<span style="background:var(--success);color:#fff;font-size:0.7rem;font-weight:600;padding:2px 8px;border-radius:12px;">✓ Received</span>'
          : '<span style="background:#f39c12;color:#fff;font-size:0.7rem;font-weight:600;padding:2px 8px;border-radius:12px;">Pending</span>';
      }
    } else {
      otaSection.style.display = "none";
    }
  }

  // Mark Settlement Button
  const markSettlementBtn = document.getElementById("mark-settlement-btn");
  if (markSettlementBtn) {
    const showSettle = isMmt && booking.settlement_status !== "received";
    markSettlementBtn.style.display = showSettle ? "block" : "none";
    if (showSettle) {
      markSettlementBtn.onclick = () => {
        showOtaSettlementModal(bookingId, booking);
      };
    }
  }

  // Set up action buttons based on booking status
  const updateBtn = document.getElementById("update-booking-btn");
  const convertBtn = document.getElementById("convert-booking-btn");
  const cancelBtn = document.getElementById("cancel-booking-btn");
  const addPaymentBtn = document.getElementById("add-payment-btn");

  if (updateBtn)
    updateBtn.style.display = booking.status === "confirmed" ? "block" : "none";
  if (convertBtn) {
    // Show convert button for confirmed bookings that are today or in the past
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const checkIn = new Date(booking.check_in_date);
    checkIn.setHours(0, 0, 0, 0);

    convertBtn.style.display =
      booking.status === "confirmed" && checkIn <= today ? "block" : "none";
  }
  if (cancelBtn)
    cancelBtn.style.display = booking.status === "confirmed" ? "block" : "none";
  if (addPaymentBtn) {
    // MMT is prepaid — no payment to collect from guest
    addPaymentBtn.style.display =
      booking.status === "confirmed" && booking.balance > 0 && !isMmt
        ? "block" : "none";
  }

  // Set up button event listeners
  if (updateBtn) {
    updateBtn.onclick = () => {
      showUpdateBookingModal(bookingId);
      detailsModal.classList.remove("show");
    };
  }

  if (convertBtn) {
    convertBtn.onclick = () => {
      showConvertBookingModal(bookingId);
      detailsModal.classList.remove("show");
    };
  }

  if (cancelBtn) {
    cancelBtn.onclick = () => {
      showCancelBookingModal(bookingId);
      detailsModal.classList.remove("show");
    };
  }

  if (addPaymentBtn) {
    addPaymentBtn.onclick = () => {
      showAddPaymentModal(bookingId);
      detailsModal.classList.remove("show");
    };
  }

  // Show the modal
  detailsModal.classList.add("show");
}

// Updated checkAvailability function for frontend
async function checkAvailability() {
  const checkInDate = document.getElementById("booking-check-in").value;
  const checkOutDate = document.getElementById("booking-check-out").value;
  const roomSelect = document.getElementById("booking-room");

  if (!checkInDate || !checkOutDate || !roomSelect) return;

  try {
    // Show loading indicator
    roomSelect.innerHTML = '<option value="">Checking availability...</option>';

    const response = await apiFetch("/check_availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        check_in_date: checkInDate,
        check_out_date: checkOutDate,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      // Populate room select with available rooms
      const availableRooms = result.available_rooms;

      if (availableRooms.length === 0) {
        roomSelect.innerHTML = '<option value="">No rooms available</option>';
        showNotification(
          "No rooms available for the selected dates",
          "warning",
        );
      } else {
        roomSelect.innerHTML = '<option value="">Select a room</option>';

        // Group rooms by floor
        const firstFloor = availableRooms.filter(
          (room) => !room.startsWith("2"),
        );
        const secondFloor = availableRooms.filter((room) =>
          room.startsWith("2"),
        );

        // Sort rooms numerically within each floor
        firstFloor.sort((a, b) => parseInt(a) - parseInt(b));
        secondFloor.sort((a, b) => parseInt(a) - parseInt(b));

        // Add first floor rooms
        if (firstFloor.length > 0) {
          const firstFloorGroup = document.createElement("optgroup");
          firstFloorGroup.label = "First Floor";

          firstFloor.forEach((room) => {
            const option = document.createElement("option");
            option.value = room;
            option.textContent = `Room ${room}`;
            firstFloorGroup.appendChild(option);
          });

          roomSelect.appendChild(firstFloorGroup);
        }

        // Add second floor rooms
        if (secondFloor.length > 0) {
          const secondFloorGroup = document.createElement("optgroup");
          secondFloorGroup.label = "Second Floor";

          secondFloor.forEach((room) => {
            const option = document.createElement("option");
            option.value = room;
            option.textContent = `Room ${room}`;
            secondFloorGroup.appendChild(option);
          });

          roomSelect.appendChild(secondFloorGroup);
        }

        // Auto-calculate price once rooms are populated
        updateBookingPriceCalc();

        console.log(
          `Found ${availableRooms.length} available rooms for dates ${checkInDate} to ${checkOutDate}`,
        );
      }
    } else {
      roomSelect.innerHTML =
        '<option value="">Error checking availability</option>';
      showNotification(
        result.message || "Error checking availability",
        "error",
      );
    }
  } catch (error) {
    console.error("Error checking availability:", error);
    roomSelect.innerHTML =
      '<option value="">Error checking availability</option>';
    showNotification(`Error checking availability: ${error.message}`, "error");
  }
}

// Helper function to check if a date is today
function isToday(dateStr) {
  const date = new Date(dateStr);
  const today = new Date();

  return (
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  );
}

// Show new booking modal
// Show new booking modal
function showNewBookingModal() {
  const modal = document.getElementById("new-booking-modal");
  if (!modal) return;

  // Reset form
  const form = document.getElementById("booking-form");
  if (form) form.reset();

  // Reset room select
  const roomSelect = document.getElementById("booking-room");
  if (roomSelect)
    roomSelect.innerHTML =
      '<option value="">Select dates to check availability</option>';

  // Set default dates (today and tomorrow)
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);

  const checkInDate = document.getElementById("booking-check-in");
  const checkOutDate = document.getElementById("booking-check-out");

  if (checkInDate) checkInDate.value = today.toISOString().split("T")[0];
  if (checkOutDate) checkOutDate.value = tomorrow.toISOString().split("T")[0];

  // Set default check-in time to 2:00 PM
  const checkInTimeInput = document.getElementById("booking-check-in-time");
  if (checkInTimeInput) {
    checkInTimeInput.value = "14:00"; // 2:00 PM
  }

  // Reset payment method
  document.querySelectorAll("#booking-form .payment-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  const cashBtn = document.querySelector("#booking-form .payment-btn.cash");
  if (cashBtn) cashBtn.classList.add("active");

  const paymentMethodInput = document.getElementById("booking-payment-method");
  if (paymentMethodInput) paymentMethodInput.value = "cash";

  // Reset photo preview
  const photoPreviewContainer = document.getElementById(
    "booking-photo-preview-container",
  );
  if (photoPreviewContainer) photoPreviewContainer.style.display = "none";

  uploadedPhotoUrl = null;

  // Reset booking source to normal and show normal payment fields
  const bookingSourceEl = document.getElementById("booking-source");
  if (bookingSourceEl) {
    bookingSourceEl.value = "normal";
    bookingSourceEl.dispatchEvent(new Event("change"));
  }

  // Check availability for default dates
  checkAvailability();

  // Show modal
  syncBookingModeButtons("single");
  modal.classList.add("show");
}

// Show OTA settlement modal
function showOtaSettlementModal(bookingId, booking) {
  const modal = document.getElementById("ota-settlement-modal");
  if (!modal) return;

  // Pre-fill booking ID and amount (using ota-prefixed IDs to avoid conflicts)
  const bookingIdInput = document.getElementById("ota-booking-id");
  if (bookingIdInput) bookingIdInput.value = bookingId;

  const amountInput = document.getElementById("ota-settlement-amount");
  if (amountInput) amountInput.value = booking.net_receivable || "";

  const netDisplay = document.getElementById("ota-net-receivable-display");
  if (netDisplay) netDisplay.textContent = "₹" + (booking.net_receivable || 0);

  // Set default settlement date to today
  const dateInput = document.getElementById("ota-settlement-date");
  if (dateInput) {
    dateInput.value = new Date().toISOString().split("T")[0];
  }

  // Clear notes
  const notesInput = document.getElementById("ota-settlement-notes");
  if (notesInput) notesInput.value = "";

  modal.classList.add("show");
}

// Submit OTA settlement
async function submitOtaSettlement(event) {
  event.preventDefault();

  const bookingId = document.getElementById("ota-booking-id")?.value;
  const settlementDate = document.getElementById("ota-settlement-date")?.value;
  const settlementAmount = parseFloat(document.getElementById("ota-settlement-amount")?.value || 0);
  const notes = document.getElementById("ota-settlement-notes")?.value || "";

  if (!bookingId || !settlementDate || !settlementAmount) {
    showNotification("Please fill all settlement fields", "error");
    return;
  }

  const submitBtn = event.target.querySelector("button[type=submit]");
  const originalContent = submitBtn?.innerHTML;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';
  }

  try {
    const response = await apiFetch("/mark_ota_settlement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        booking_id: bookingId,
        settlement_date: settlementDate,
        settlement_amount: settlementAmount,
        notes,
      }),
    });

    if (!response.ok) throw new Error(`Server error: ${response.status}`);
    const result = await response.json();

    if (result.success) {
      const modal = document.getElementById("ota-settlement-modal");
      if (modal) modal.classList.remove("show");
      showNotification("OTA settlement recorded successfully!", "success");
      fetchBookings();
    } else {
      showNotification(result.message || "Error recording settlement", "error");
    }
  } catch (error) {
    console.error("Error submitting OTA settlement:", error);
    showNotification(`Error: ${error.message}`, "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalContent;
    }
  }
}

// Show cancel booking modal
function showCancelBookingModal(bookingId) {
  const booking = bookings.find((b) => b.booking_id === bookingId);
  if (!booking) return;

  const modal = document.getElementById("cancel-booking-modal");
  if (!modal) return;

  // Set booking details
  document.getElementById("cancel-booking-id").value = bookingId;
  document.getElementById("cancel-room-number").textContent = booking.room;
  document.getElementById("cancel-guest-name").textContent = booking.guest_name;
  document.getElementById("cancel-check-in").textContent = formatDate(
    new Date(booking.check_in_date),
  );

  // Set refund amount to what was paid
  const refundAmountInput = document.getElementById("cancel-refund-amount");
  if (refundAmountInput) {
    refundAmountInput.max = booking.paid_amount;
    refundAmountInput.value = booking.paid_amount;
  }

  // ── Cancellation forfeiture (SAC 999794, 18% inclusive) ──────────────────
  // The retained portion = paid_amount − refund_amount. When the operator
  // ticks the checkbox, render the GST split live as they edit the refund.
  // Backend mints a separate Tax Invoice for this amount.
  const _retainCheck   = document.getElementById("cancel-retain-charge");
  const _retainSummary = document.getElementById("cancel-retain-summary");
  const _retainAmtEl   = document.getElementById("cancel-retain-amt");
  const _retainTaxEl   = document.getElementById("cancel-retain-taxable");
  const _retainCgstEl  = document.getElementById("cancel-retain-cgst");
  const _retainSgstEl  = document.getElementById("cancel-retain-sgst");
  const _paidAmt       = parseInt(booking.paid_amount || 0, 10) || 0;

  function _bkFmtR(n) { return "₹" + (n || 0).toLocaleString("en-IN"); }
  function _bkRefreshRetain() {
    if (!_retainCheck || !_retainSummary) return;
    const refund   = parseInt((refundAmountInput && refundAmountInput.value) || 0, 10) || 0;
    const retained = Math.max(0, _paidAmt - refund);
    if (_retainCheck.checked && retained > 0) {
      _retainSummary.style.display = "";
      const gst     = Math.round((retained * 18 / 118) * 100) / 100;
      const taxable = Math.round((retained - gst) * 100) / 100;
      const half    = Math.round((gst / 2) * 100) / 100;
      if (_retainAmtEl)  _retainAmtEl.textContent  = _bkFmtR(retained);
      if (_retainTaxEl)  _retainTaxEl.textContent  = _bkFmtR(taxable);
      if (_retainCgstEl) _retainCgstEl.textContent = _bkFmtR(half);
      if (_retainSgstEl) _retainSgstEl.textContent = _bkFmtR(half);
    } else {
      _retainSummary.style.display = "none";
    }
  }
  // Default: pre-tick if paid > 0 — most operators keep some forfeiture.
  if (_retainCheck) {
    _retainCheck.checked = (_paidAmt > 0);
    // Avoid stacking listeners on repeated modal opens.
    const _newCheck = _retainCheck.cloneNode(true);
    _retainCheck.parentNode.replaceChild(_newCheck, _retainCheck);
    _newCheck.addEventListener("change", _bkRefreshRetain);
  }
  if (refundAmountInput) {
    const _newRef = refundAmountInput.cloneNode(true);
    refundAmountInput.parentNode.replaceChild(_newRef, refundAmountInput);
    _newRef.addEventListener("input", _bkRefreshRetain);
  }
  _bkRefreshRetain();

  // Show modal
  modal.classList.add("show");
}

// Initialize cancel booking form
function initializeCancelBookingForm() {
  const form = document.getElementById("cancel-booking-form");
  if (!form) return;

  // Payment Method Selection
  document
    .querySelectorAll("#cancel-booking-form .payment-btn")
    .forEach((btn) => {
      btn.addEventListener("click", function () {
        document
          .querySelectorAll("#cancel-booking-form .payment-btn")
          .forEach((b) => {
            b.classList.remove("active");
          });
        this.classList.add("active");
        const paymentMethod = this.dataset.payment;
        document.getElementById("cancel-refund-method").value = paymentMethod;
      });
    });

  // Form submission
  form.addEventListener("submit", async function (event) {
    event.preventDefault();

    const bookingId = document.getElementById("cancel-booking-id").value;
    const refundAmount = parseInt(
      document.getElementById("cancel-refund-amount").value || 0,
    );
    const refundMethod = document.getElementById("cancel-refund-method").value;
    const reason = document.getElementById("cancel-reason").value;

    // Validation
    if (!bookingId) {
      showNotification("Invalid booking ID", "error");
      return;
    }

    const booking = bookings.find((b) => b.booking_id === bookingId);
    if (!booking) {
      showNotification("Booking not found", "error");
      return;
    }

    if (refundAmount > booking.paid_amount) {
      showNotification("Refund amount cannot exceed paid amount", "error");
      return;
    }

    // Disable submit button
    const submitBtn = event.target.querySelector("button[type=submit]");
    if (!submitBtn) return;

    const originalContent = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML =
      '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

    try {
      const _retainEl = document.getElementById("cancel-retain-charge");
      const retainAsCharge = !!(_retainEl && _retainEl.checked);
      const response = await apiFetch("/cancel_booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          booking_id: bookingId,
          refund_amount: refundAmount,
          refund_method: refundMethod,
          reason: reason,
          retain_as_charge: retainAsCharge,
        }),
      });

      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }

      const result = await response.json();

      if (result.success) {
        // Close modal and refresh data
        const cancelModal = document.getElementById("cancel-booking-modal");
        if (cancelModal) {
          cancelModal.classList.remove("show");
        }

        // Reset form
        event.target.reset();

        // Show success — include the cancellation-charge invoice number when
        // the operator chose to keep the retained amount as a 999794 supply.
        const _chrgNo = result.charge_bill_number;
        const _msg    = _chrgNo
          ? `Booking cancelled. Cancellation invoice ${_chrgNo} issued (SAC 999794 / 18%).`
          : "Booking cancelled successfully!";
        showNotification(_msg, "success");

        // Refresh bookings
        fetchBookings();
      } else {
        showNotification(result.message || "Error cancelling booking", "error");
      }
    } catch (error) {
      console.error("Error cancelling booking:", error);
      showNotification(`Error cancelling booking: ${error.message}`, "error");
    } finally {
      // Re-enable submit button
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalContent;
    }
  });
}

// Show convert booking modal - Updated with time
function showConvertBookingModal(bookingId) {
  const booking = bookings.find((b) => b.booking_id === bookingId);
  if (!booking) return;

  const modal = document.getElementById("convert-booking-modal");
  if (!modal) return;

  // Format check-in time
  const checkInTime = booking.check_in_time || "14:00";
  const formattedTime = formatTime(checkInTime);
  const formattedDate = formatDate(new Date(booking.check_in_date));

  // Set booking details
  document.getElementById("convert-booking-id").value = bookingId;
  document.getElementById("convert-room-number").textContent = booking.room;
  document.getElementById("convert-guest-name").textContent =
    booking.guest_name;

  // Show date and time together
  document.getElementById("convert-check-in").textContent =
    `${formattedDate} at ${formattedTime}`;

  const isMmtBooking = isOtaPrepaid(booking.booking_source);

  // Payment summary rows
  const totalRow = document.getElementById("convert-total-amount")?.closest(".summary-row");
  const paidRow = document.getElementById("convert-paid-amount")?.closest(".summary-row");
  const balanceRow = document.getElementById("convert-balance")?.closest(".summary-row");
  const paymentAmountGroup = document.getElementById("convert-remaining-payment")?.closest(".form-group");
  const paymentMethodGroup = document.querySelector("#convert-booking-form .payment-options")?.closest(".form-group");

  // MMT info banner (create once, reuse)
  let mmtInfoBanner = document.getElementById("convert-mmt-info");
  if (!mmtInfoBanner) {
    mmtInfoBanner = document.createElement("div");
    mmtInfoBanner.id = "convert-mmt-info";
    mmtInfoBanner.style.cssText = "background:rgba(99,179,237,0.12);border:1px solid rgba(99,179,237,0.3);border-radius:8px;padding:0.6rem 0.9rem;margin-top:1rem;color:#63b3ed;font-size:0.85rem;text-align:center;";
    mmtInfoBanner.innerHTML = '<i class="fas fa-info-circle"></i> MMT Prepaid — No payment to collect. Settlement will be received from MMT directly.';
    document.querySelector("#convert-booking-form .summary-card")?.after(mmtInfoBanner);
  }

  if (isMmtBooking) {
    // Hide payment-related rows and inputs for MMT
    if (totalRow) totalRow.style.display = "none";
    if (paidRow) paidRow.style.display = "none";
    if (balanceRow) balanceRow.style.display = "none";
    if (paymentAmountGroup) paymentAmountGroup.style.display = "none";
    if (paymentMethodGroup) paymentMethodGroup.style.display = "none";
    mmtInfoBanner.style.display = "block";

    // Force zero payment for MMT
    const remainingPayment = document.getElementById("convert-remaining-payment");
    if (remainingPayment) remainingPayment.value = 0;
    const paymentMethodInput = document.getElementById("convert-payment-method");
    if (paymentMethodInput) paymentMethodInput.value = "ota";
  } else {
    // Normal booking — show all payment fields
    if (totalRow) totalRow.style.display = "";
    if (paidRow) paidRow.style.display = "";
    if (balanceRow) balanceRow.style.display = "";
    if (paymentAmountGroup) paymentAmountGroup.style.display = "";
    if (paymentMethodGroup) paymentMethodGroup.style.display = "";
    mmtInfoBanner.style.display = "none";

    document.getElementById("convert-total-amount").textContent = `₹${booking.total_amount}`;
    document.getElementById("convert-paid-amount").textContent = `₹${booking.paid_amount}`;
    document.getElementById("convert-balance").textContent = `₹${booking.balance}`;

    // Set remaining payment input to the balance amount
    const remainingPayment = document.getElementById("convert-remaining-payment");
    if (remainingPayment) {
      remainingPayment.max = booking.balance;
      remainingPayment.value = booking.balance > 0 ? booking.balance : 0;
      // Clear any "Later" lock left over from a previous open of this modal.
      remainingPayment.readOnly = false;
      remainingPayment.style.opacity = "";
      delete remainingPayment.dataset.prevValue;
    }

    // Reset payment method to cash
    document
      .querySelectorAll("#convert-booking-form .payment-btn")
      .forEach((btn) => { btn.classList.remove("active"); });

    const cashBtn = document.querySelector("#convert-booking-form .payment-btn.cash");
    if (cashBtn) cashBtn.classList.add("active");

    const paymentMethodInput = document.getElementById("convert-payment-method");
    if (paymentMethodInput) paymentMethodInput.value = "cash";
  }

  // Show modal
  modal.classList.add("show");
}

// Initialize convert booking form
function initializeConvertBookingForm() {
  const form = document.getElementById("convert-booking-form");
  if (!form) return;

  // Payment Method Selection
  document
    .querySelectorAll("#convert-booking-form .payment-btn")
    .forEach((btn) => {
      btn.addEventListener("click", function () {
        document
          .querySelectorAll("#convert-booking-form .payment-btn")
          .forEach((b) => {
            b.classList.remove("active");
          });
        this.classList.add("active");
        const paymentMethod = this.dataset.payment;
        document.getElementById("convert-payment-method").value = paymentMethod;

        // "Later" collects nothing now - the whole balance rides on the room,
        // exactly as it does for a walk-in check-in. Zero the field and lock
        // it so the number on screen always matches what gets posted.
        const amtInput = document.getElementById("convert-remaining-payment");
        if (amtInput) {
          if (paymentMethod === "balance") {
            amtInput.dataset.prevValue = amtInput.value;
            amtInput.value = 0;
            amtInput.readOnly = true;
            amtInput.style.opacity = "0.6";
          } else if (amtInput.readOnly) {
            amtInput.readOnly = false;
            amtInput.style.opacity = "";
            amtInput.value = amtInput.dataset.prevValue || amtInput.max || 0;
          }
        }
      });
    });

  // ── Form submission - optimistic ─────────────────────────────────────
  // The room card flips to occupied and the modal closes IMMEDIATELY; the
  // POST runs in the background through optimistic.js's per-room FIFO queue
  // and the card is rolled back with a loud error if the server refuses.
  // Same pattern as the walk-in check-in in script.js. A double submit is
  // additionally impossible server-side: convert_booking_to_checkin rejects
  // a room that is no longer vacant.
  form.addEventListener("submit", function (event) {
    event.preventDefault();

    const bookingId = document.getElementById("convert-booking-id").value;
    const paymentMethod = document.getElementById(
      "convert-payment-method",
    ).value;
    // "balance" = Pay Later. Nothing is collected at check-in.
    const remainingPayment =
      paymentMethod === "balance"
        ? 0
        : parseInt(
            document.getElementById("convert-remaining-payment").value || 0,
          );

    // Validation
    if (!bookingId) {
      showNotification("Invalid booking ID", "error");
      return;
    }

    const booking = bookings.find((b) => b.booking_id === bookingId);
    if (!booking) {
      showNotification("Booking not found", "error");
      return;
    }

    if (remainingPayment > booking.balance) {
      showNotification("Payment amount cannot exceed balance", "error");
      return;
    }

    const submitBtn = event.target.querySelector("button[type=submit]");
    if (!submitBtn) return;

    const originalContent = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML =
      '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

    const roomNumber = booking.room;
    const modal = document.getElementById("convert-booking-modal");
    const _body = {
      booking_id: bookingId,
      remaining_payment: remainingPayment,
      payment_method: paymentMethod,
    };

    // ── Predicted post-conversion room state ───────────────────────────
    // Mirrors routes/bookings.py :: convert_booking_to_checkin. It exists
    // only to paint the card in the same frame as the click;
    // debouncedFetchData() re-hydrates from the server moments later and
    // overwrites anything guessed wrong here. No money decision is made
    // from these numbers.
    const _predict = () => {
      let nights = 1;
      const _ci = new Date(booking.check_in_date);
      const _co = new Date(booking.check_out_date);
      const _d = Math.round((_co - _ci) / 86400000);
      if (Number.isFinite(_d) && _d > 0) nights = _d;

      const total = parseInt(booking.total_amount || 0) || 0;
      const stored = parseInt(booking.rate_per_night || 0) || 0;
      // Per-night price = whole-stay total / nights (the server's rule).
      let price = total;
      if (total > 0 && nights > 0) price = Math.round(total / nights);
      else if (stored > 0) price = stored;

      const isOta = isOtaPrepaid(booking.booking_source);
      const paid = (parseInt(booking.paid_amount || 0) || 0) + remainingPayment;

      return {
        price: price,
        // OTA/MMT stays are prepaid in full: zero balance, all nights charged.
        balance: isOta ? 0 : price - paid,
        renewalCount: isOta ? Math.max(nights - 1, 0) : 0,
        payment: isOta ? "ota" : paymentMethod,
      };
    };

    // Patch local state + repaint. Returns a snapshot for rollback.
    const _applyPatch = () => {
      const roomsMap = window.rooms || {};
      const snap = {
        room: roomsMap[roomNumber] ? { ...roomsMap[roomNumber] } : null,
        bookingStatus: booking.status,
        upcoming: (window.upcomingBookings || {})[roomNumber] || null,
      };

      const p = _predict();
      const now = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      const nowStr =
        `${now.getFullYear()}-${p2(now.getMonth() + 1)}-` +
        `${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;

      const patch = {
        status: "occupied",
        guest: {
          name: booking.guest_name,
          mobile: booking.guest_mobile,
          price: p.price,
          guests: booking.guest_count,
          payment: p.payment,
          balance: p.balance,
          isAC: !!booking.is_ac,
        },
        balance: p.balance,
        checkin_time: nowStr,
        add_ons: [],
        renewal_count: p.renewalCount,
        booking_source: booking.booking_source || "normal",
        gst_profile: null,
      };
      if (
        window.CibaraState &&
        typeof window.CibaraState.patchRoom === "function"
      ) {
        window.CibaraState.patchRoom(roomNumber, patch);
      } else if (roomsMap[roomNumber]) {
        window.rooms[roomNumber] = Object.assign({}, roomsMap[roomNumber], patch);
      }

      // The arrival dot belongs to a booking that has now arrived.
      if (window.upcomingBookings) delete window.upcomingBookings[roomNumber];

      booking.status = "checked_in";

      if (typeof renderRooms === "function") renderRooms();
      if (typeof updateStats === "function") updateStats();
      renderBookings();

      return snap;
    };

    const _restore = (snap) => {
      const before = (snap && snap.room) || {};
      // Explicit key-by-key undo. patchRoom MERGES, and a vacant room doc
      // simply has no `guest` key - so replaying the snapshot alone would
      // leave the guest we invented in place and the card would stay looking
      // occupied after a failed write. Every key _applyPatch() writes must
      // be named here.
      const undo = {
        status: before.status || "vacant",
        guest: before.guest || null,
        balance: before.balance || 0,
        checkin_time: before.checkin_time || null,
        add_ons: before.add_ons || [],
        renewal_count: before.renewal_count || 0,
        booking_source: before.booking_source || "normal",
        gst_profile: before.gst_profile || null,
      };
      if (
        window.CibaraState &&
        typeof window.CibaraState.patchRoom === "function"
      ) {
        window.CibaraState.patchRoom(roomNumber, undo);
      } else if (window.rooms && window.rooms[roomNumber]) {
        window.rooms[roomNumber] = Object.assign(
          {},
          window.rooms[roomNumber],
          undo,
        );
      }
      if (snap && snap.upcoming && window.upcomingBookings) {
        window.upcomingBookings[roomNumber] = snap.upcoming;
      }
      if (snap) booking.status = snap.bookingStatus;
      if (typeof renderRooms === "function") renderRooms();
      if (typeof updateStats === "function") updateStats();
      renderBookings();
    };

    const _onSuccess = (result) => {
      // Serial number for the register view.
      if (typeof transactionTracker !== "undefined" && transactionTracker) {
        try {
          transactionTracker.processCheckin(roomNumber, null, true);
        } catch (e) {
          console.error("serial assignment failed:", e);
        }
      }
      let message =
        result.message || "Booking converted to check-in successfully!";
      if (result.serial_number) message += ` (Serial #${result.serial_number})`;
      showNotification(message, "success");

      // Authoritative background hydrate - corrects any predicted value.
      fetchBookings();
      debouncedFetchData();
    };

    // Defensive fallback: if optimistic.js failed to load, use the old
    // await-then-paint flow so check-in never becomes impossible.
    if (typeof window.optimisticWrite !== "function") {
      (async () => {
        try {
          const response = await apiFetch("/convert_booking_to_checkin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(_body),
          });
          if (!response.ok) {
            throw new Error(`Server responded with status: ${response.status}`);
          }
          const result = await response.json();
          if (result.success) {
            if (modal) modal.classList.remove("show");
            form.reset();
            _applyPatch();
            _onSuccess(result);
            window.dispatchEvent(
              new CustomEvent("cibaraRoomUpdate", {
                detail: { type: "checkin_conversion" },
              }),
            );
          } else {
            showNotification(
              result.message || "Error converting booking",
              "error",
            );
          }
        } catch (error) {
          console.error("Error converting booking:", error);
          showNotification(
            `Error converting booking: ${error.message}`,
            "error",
          );
        } finally {
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalContent;
        }
      })();
      return;
    }

    window.optimisticWrite({
      key: roomNumber,
      label: "check-in",
      apply() {
        if (modal) modal.classList.remove("show");
        form.reset();
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalContent;
        const snap = _applyPatch();
        window.dispatchEvent(
          new CustomEvent("cibaraRoomUpdate", {
            detail: { type: "checkin_conversion" },
          }),
        );
        return snap;
      },
      rollback(snap) {
        _restore(snap);
        window.dispatchEvent(
          new CustomEvent("cibaraRoomUpdate", {
            detail: { type: "checkin_conversion" },
          }),
        );
      },
      request(opId) {
        return apiFetch("/convert_booking_to_checkin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.assign({}, _body, { op_id: opId })),
        });
      },
      onSuccess: _onSuccess,
      onError() {
        // The room is vacant again and the booking is back in the list;
        // re-sync from the server so nothing local is left guessing.
        fetchBookings();
        debouncedFetchData();
      },
    });
  });
}

// Show add payment modal
function showAddPaymentModal(bookingId) {
  const booking = bookings.find((b) => b.booking_id === bookingId);
  if (!booking) return;

  const modal = document.getElementById("add-payment-modal");
  if (!modal) return;

  // Set booking details
  document.getElementById("payment-booking-id").value = bookingId;
  document.getElementById("payment-room-number").textContent = booking.room;
  document.getElementById("payment-guest-name").textContent =
    booking.guest_name;
  document.getElementById("payment-total-amount").textContent =
    `₹${booking.total_amount}`;
  document.getElementById("payment-paid-amount").textContent =
    `₹${booking.paid_amount}`;
  document.getElementById("payment-balance").textContent =
    `₹${booking.balance}`;

  // Set payment amount input to the balance amount
  const paymentAmount = document.getElementById("payment-amount");
  if (paymentAmount) {
    paymentAmount.max = booking.balance;
    paymentAmount.value = booking.balance;
  }

  // Show modal
  modal.classList.add("show");
}

// Initialize add payment form
function initializeAddPaymentForm() {
  const form = document.getElementById("add-payment-form");
  if (!form) return;

  // Payment Method Selection
  document.querySelectorAll("#add-payment-form .payment-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      document
        .querySelectorAll("#add-payment-form .payment-btn")
        .forEach((b) => {
          b.classList.remove("active");
        });
      this.classList.add("active");
      const paymentMethod = this.dataset.payment;
      document.getElementById("payment-method").value = paymentMethod;
    });
  });

  // Form submission
  form.addEventListener("submit", async function (event) {
    event.preventDefault();

    const bookingId = document.getElementById("payment-booking-id").value;
    const paymentAmount = parseInt(
      document.getElementById("payment-amount").value || 0,
    );
    const paymentMethod = document.getElementById("payment-method").value;

    // Validation
    if (!bookingId) {
      showNotification("Invalid booking ID", "error");
      return;
    }

    const booking = bookings.find((b) => b.booking_id === bookingId);
    if (!booking) {
      showNotification("Booking not found", "error");
      return;
    }

    if (paymentAmount <= 0) {
      showNotification("Payment amount must be greater than zero", "error");
      return;
    }

    if (paymentAmount > booking.balance) {
      showNotification("Payment amount cannot exceed balance", "error");
      return;
    }

    // Disable submit button
    const submitBtn = event.target.querySelector("button[type=submit]");
    if (!submitBtn) return;

    const originalContent = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML =
      '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

    try {
      const response = await apiFetch("/update_booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          booking_id: bookingId,
          new_payment: paymentAmount,
          payment_method: paymentMethod,
        }),
      });

      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }

      const result = await response.json();

      if (result.success) {
        // Close modal and refresh data
        const paymentModal = document.getElementById("add-payment-modal");
        if (paymentModal) {
          paymentModal.classList.remove("show");
        }

        // Reset form
        event.target.reset();

        // Show success notification
        showNotification(
          `Payment of ₹${paymentAmount} added successfully!`,
          "success",
        );

        // Refresh bookings
        fetchBookings();
      } else {
        showNotification(result.message || "Error adding payment", "error");
      }
    } catch (error) {
      console.error("Error adding payment:", error);
      showNotification(`Error adding payment: ${error.message}`, "error");
    } finally {
      // Re-enable submit button
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalContent;
    }
  });
}

// Show update booking modal
// Show update booking modal
function showUpdateBookingModal(bookingId) {
  const booking = bookings.find((b) => b.booking_id === bookingId);
  if (!booking) return;

  const modal = document.getElementById("update-booking-modal");
  if (!modal) return;

  // Set form fields
  document.getElementById("update-booking-id").value = bookingId;
  document.getElementById("update-guest-name").value = booking.guest_name;
  document.getElementById("update-guest-mobile").value = booking.guest_mobile;
  document.getElementById("update-check-in").value = booking.check_in_date;
  document.getElementById("update-check-in-time").value =
    booking.check_in_time || "14:00"; // Default to 2 PM if not set
  document.getElementById("update-check-out").value = booking.check_out_date;
  document.getElementById("update-guest-count").value =
    booking.guest_count || 1;
  document.getElementById("update-total-amount").value = booking.total_amount;
  document.getElementById("update-notes").value = booking.notes || "";

  // Populate AC toggle. The container is shown only for AC-capable rooms
  // (200-206). On open we use the booking's current room; updateUpdateAcUi()
  // re-evaluates whenever the user picks a different room from the dropdown.
  const _acToggle = document.getElementById("update-ac-toggle");
  if (_acToggle) {
    _acToggle.checked = booking.is_ac === true;
  }
  updateUpdateAcUi(booking.room);

  // Set room options
  updateRoomOptions(
    booking.room,
    booking.check_in_date,
    booking.check_out_date,
  );

  // Show modal
  modal.classList.add("show");
}

// Show/hide and refresh the AC toggle on the Update Booking modal based on
// the currently selected room. Mirrors the show/hide logic used by the new
// booking form's updateBookingPriceCalc, but does NOT recalculate the total
// — staff editing a booking may have manually set a price and we don't want
// to overwrite it silently when they tick the AC flag. They can adjust the
// total field by hand if needed.
function updateUpdateAcUi(roomNumber) {
  const container = document.getElementById("update-ac-toggle-container");
  const toggle    = document.getElementById("update-ac-toggle");
  const label     = document.getElementById("update-ac-label");
  const slider    = document.getElementById("update-ac-slider");
  if (!container || !toggle) return;

  const isAcRoom = BOOKING_AC_ROOMS.includes(String(roomNumber || ""));
  container.style.display = isAcRoom ? "block" : "none";
  // If the user switches to a non-AC room, clear the flag so we don't
  // accidentally persist isAC=true on a room that can't have AC.
  if (!isAcRoom) toggle.checked = false;

  const on = toggle.checked;
  if (label) {
    label.textContent = on ? "ON" : "OFF";
    label.style.color = on ? "#0284c7" : "#64748b";
  }
  if (slider) {
    slider.style.background = on ? "#0ea5e9" : "#cbd5e1";
  }
}

// Initialize update booking form
// Initialize update booking form
function initializeUpdateBookingForm() {
  const form = document.getElementById("update-booking-form");
  if (!form) return;

  // Handle check dates change
  const checkInDate = document.getElementById("update-check-in");
  const checkOutDate = document.getElementById("update-check-out");

  if (checkInDate && checkOutDate) {
    // Set min date to today
    const today = new Date().toISOString().split("T")[0];
    checkInDate.min = today;
    checkOutDate.min = today;

    // Update checkout min date when checkin changes
    checkInDate.addEventListener("change", function () {
      checkOutDate.min = this.value;
      if (checkOutDate.value && checkOutDate.value < this.value) {
        checkOutDate.value = this.value;
      }

      const bookingId = document.getElementById("update-booking-id").value;
      const booking = bookings.find((b) => b.booking_id === bookingId);
      if (booking) {
        updateRoomOptions(booking.room, this.value, checkOutDate.value);
      }
    });

    checkOutDate.addEventListener("change", function () {
      const bookingId = document.getElementById("update-booking-id").value;
      const booking = bookings.find((b) => b.booking_id === bookingId);
      if (booking) {
        updateRoomOptions(booking.room, checkInDate.value, this.value);
      }
    });
  }

  // Room change → refresh AC toggle visibility for the newly selected room.
  // Without this, the toggle would stay visible/hidden based on the old
  // room until the modal is reopened.
  const roomSelectEl = document.getElementById("update-room");
  if (roomSelectEl) {
    roomSelectEl.addEventListener("change", function () {
      updateUpdateAcUi(this.value);
    });
  }

  // Toggle change → refresh slider visuals (CSS handles the knob position,
  // JS handles label + slider background colour).
  const acToggleEl = document.getElementById("update-ac-toggle");
  if (acToggleEl) {
    acToggleEl.addEventListener("change", function () {
      const room = (roomSelectEl && roomSelectEl.value) || "";
      updateUpdateAcUi(room);
    });
  }

  // Form submission
  form.addEventListener("submit", async function (event) {
    event.preventDefault();

    const bookingId = document.getElementById("update-booking-id").value;
    const guestName = document.getElementById("update-guest-name").value;
    const guestMobile = document.getElementById("update-guest-mobile").value;
    const checkInDate = document.getElementById("update-check-in").value;
    const checkInTime = document.getElementById("update-check-in-time").value;
    const checkOutDate = document.getElementById("update-check-out").value;
    const room = document.getElementById("update-room").value;
    const guestCount = parseInt(
      document.getElementById("update-guest-count").value,
    );
    const totalAmount = parseInt(
      document.getElementById("update-total-amount").value,
    );
    const notes = document.getElementById("update-notes").value;

    // AC flag — only meaningful for rooms 200-206. We always include it in
    // the payload (defaulting to false for non-AC rooms) so the server can
    // flip an existing isAC=true off if staff swap to a non-AC room.
    const _updateAcToggle = document.getElementById("update-ac-toggle");
    const isAc =
      BOOKING_AC_ROOMS.includes(String(room)) && _updateAcToggle
        ? _updateAcToggle.checked
        : false;

    // Look up the booking first so phone-number validation can be relaxed for
    // OTA (MMT) bookings, whose vouchers often don't carry a guest phone.
    const booking = bookings.find((b) => b.booking_id === bookingId);
    if (!booking) {
      showNotification("Booking not found", "error");
      return;
    }
    // Validation — guest_mobile is intentionally NOT required on update. The
    // backend never required it, and MMT/OTA bookings often arrive with no
    // phone number. (New walk-in booking creation still asks for it in its
    // own form; this only relaxes the EDIT/update form.)
    if (
      !bookingId ||
      !guestName ||
      !checkInDate ||
      !checkInTime ||
      !checkOutDate ||
      !room ||
      !totalAmount
    ) {
      showNotification("Please fill all required fields", "error");
      return;
    }

    // Validate dates
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const checkIn = new Date(checkInDate);
    checkIn.setHours(0, 0, 0, 0);
    const checkOut = new Date(checkOutDate);
    checkOut.setHours(0, 0, 0, 0);

    if (
      checkIn < today &&
      checkIn.getTime() !== new Date(booking.check_in_date).getTime()
    ) {
      showNotification("Check-in date cannot be in the past", "error");
      return;
    }

    if (checkOut <= checkIn) {
      showNotification("Check-out date must be after check-in date", "error");
      return;
    }

    // Disable submit button
    const submitBtn = event.target.querySelector("button[type=submit]");
    if (!submitBtn) return;

    const originalContent = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML =
      '<span class="loader" style="width: 20px; height: 20px;"></span> Processing...';

    try {
      const response = await apiFetch("/update_booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          booking_id: bookingId,
          guest_name: guestName,
          guest_mobile: guestMobile,
          check_in_date: checkInDate,
          check_in_time: checkInTime,
          check_out_date: checkOutDate,
          room: room,
          guest_count: guestCount,
          total_amount: totalAmount,
          notes: notes,
          is_ac: isAc,
        }),
      });

      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }

      const result = await response.json();

      if (result.success) {
        // Close modal and refresh data
        const updateModal = document.getElementById("update-booking-modal");
        if (updateModal) {
          updateModal.classList.remove("show");
        }

        // Show success notification
        showNotification("Booking updated successfully!", "success");

        // Refresh bookings
        fetchBookings();
      } else {
        showNotification(result.message || "Error updating booking", "error");
      }
    } catch (error) {
      console.error("Error updating booking:", error);
      showNotification(`Error updating booking: ${error.message}`, "error");
    } finally {
      // Re-enable submit button
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalContent;
    }
  });
}

// Fixed updateRoomOptions function for editing bookings
async function updateRoomOptions(currentRoom, checkInDate, checkOutDate) {
  const roomSelect = document.getElementById("update-room");
  if (!roomSelect) return;

  try {
    // Show loading indicator
    roomSelect.innerHTML = '<option value="">Checking availability...</option>';

    const response = await apiFetch("/check_availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        check_in_date: checkInDate,
        check_out_date: checkOutDate,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      // Always include the current room in the available rooms list
      // since it should always be an option when editing
      let availableRooms = result.available_rooms;
      if (!availableRooms.includes(currentRoom)) {
        availableRooms = [...availableRooms, currentRoom];
      }

      // Sort room numbers numerically
      availableRooms.sort((a, b) => {
        const aNum = parseInt(a);
        const bNum = parseInt(b);
        return aNum - bNum;
      });

      // Populate room select with available rooms
      if (availableRooms.length === 0) {
        roomSelect.innerHTML = '<option value="">No rooms available</option>';
      } else {
        roomSelect.innerHTML = "";

        // Group rooms by floor
        const firstFloor = availableRooms.filter(
          (room) => !room.startsWith("2"),
        );
        const secondFloor = availableRooms.filter((room) =>
          room.startsWith("2"),
        );

        // Add first floor rooms
        if (firstFloor.length > 0) {
          const firstFloorGroup = document.createElement("optgroup");
          firstFloorGroup.label = "First Floor";

          firstFloor.forEach((room) => {
            const option = document.createElement("option");
            option.value = room;
            option.textContent = `Room ${room}`;
            if (room === currentRoom) {
              option.selected = true;
            }
            firstFloorGroup.appendChild(option);
          });

          roomSelect.appendChild(firstFloorGroup);
        }

        // Add second floor rooms
        if (secondFloor.length > 0) {
          const secondFloorGroup = document.createElement("optgroup");
          secondFloorGroup.label = "Second Floor";

          secondFloor.forEach((room) => {
            const option = document.createElement("option");
            option.value = room;
            option.textContent = `Room ${room}`;
            if (room === currentRoom) {
              option.selected = true;
            }
            secondFloorGroup.appendChild(option);
          });

          roomSelect.appendChild(secondFloorGroup);
        }
      }
    } else {
      roomSelect.innerHTML =
        '<option value="">Error checking availability</option>';
      showNotification(
        result.message || "Error checking availability",
        "error",
      );
    }
  } catch (error) {
    console.error("Error checking availability:", error);
    roomSelect.innerHTML =
      '<option value="">Error checking availability</option>';
    showNotification(`Error checking availability: ${error.message}`, "error");
  }
}

// Initialize all payment-related forms on page load
document.addEventListener("DOMContentLoaded", function () {
  initializeAddPaymentForm();
});
// Camera functionality for booking photos
document.addEventListener("DOMContentLoaded", function () {
  // Initialize booking camera
  initBookingCamera();
});

// Initialize camera functionality for booking photos
function initBookingCamera() {
  const cameraBtn = document.getElementById("booking-camera-btn");
  const cameraContainer = document.getElementById("booking-camera-container");
  const cameraFeed = document.getElementById("booking-camera-feed");
  const captureBtn = document.getElementById("booking-capture-photo-btn");
  const cancelCameraBtn = document.getElementById("booking-cancel-camera-btn");
  const photoPreviewContainer = document.getElementById(
    "booking-photo-preview-container",
  );
  const photoPreview = document.getElementById("booking-photo-preview");
  const retakePhotoBtn = document.getElementById("booking-retake-photo-btn");
  const fileInput = document.getElementById("booking-guest-photo");

  if (!cameraBtn || !fileInput) {
    debugLog("Booking camera elements not found");
    return;
  }

  // File input change event
  fileInput.addEventListener("change", function (event) {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = function (e) {
        if (photoPreview && photoPreviewContainer) {
          photoPreview.src = e.target.result;
          photoPreviewContainer.style.display = "block";
          capturedPhotoData = e.target.result;
        }

        // Upload the photo to server
        uploadPhoto(file);
      };
      reader.readAsDataURL(file);
    }
  });

  // Camera button click event
  cameraBtn.addEventListener("click", async function () {
    try {
      // Close camera first if it's already open
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
      }

      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });

      if (cameraFeed && cameraContainer) {
        cameraFeed.srcObject = mediaStream;
        cameraContainer.style.display = "block";
        if (photoPreviewContainer) {
          photoPreviewContainer.style.display = "none";
        }
      }
    } catch (error) {
      console.error("Error accessing camera:", error);
      showNotification(
        "Error accessing camera. Please check permissions.",
        "error",
      );
    }
  });

  // Capture photo button click event
  if (captureBtn) {
    captureBtn.addEventListener("click", function () {
      if (!cameraFeed) {
        debugLog("Camera feed element not found");
        return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = cameraFeed.videoWidth;
      canvas.height = cameraFeed.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(cameraFeed, 0, 0, canvas.width, canvas.height);

      capturedPhotoData = canvas.toDataURL("image/jpeg");

      if (photoPreview && photoPreviewContainer && cameraContainer) {
        photoPreview.src = capturedPhotoData;
        photoPreviewContainer.style.display = "block";
        cameraContainer.style.display = "none";
      }

      // Convert data URL to Blob
      const byteString = atob(capturedPhotoData.split(",")[1]);
      const mimeString = capturedPhotoData
        .split(",")[0]
        .split(":")[1]
        .split(";")[0];
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([ab], { type: mimeString });

      // Create a File from the Blob
      const file = new File([blob], "booking-camera-capture.jpg", {
        type: "image/jpeg",
      });

      // Upload the photo
      uploadPhoto(file);

      // Stop camera stream
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }
    });
  }

  // Cancel camera button click event
  if (cancelCameraBtn) {
    cancelCameraBtn.addEventListener("click", function () {
      if (cameraContainer) {
        cameraContainer.style.display = "none";
      }

      // Stop camera stream
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }
    });
  }

  // Retake photo button click event
  if (retakePhotoBtn) {
    retakePhotoBtn.addEventListener("click", function () {
      if (photoPreviewContainer) {
        photoPreviewContainer.style.display = "none";
      }
      capturedPhotoData = null;
      uploadedPhotoUrl = null;

      // Clear file input
      if (fileInput) {
        fileInput.value = "";
      }
    });
  }
}
// Calendar View for Bookings
let currentCalendarDate = new Date();
let currentCalendarView = "list"; // 'list' or 'calendar'

// Initialize calendar when DOM is loaded
document.addEventListener("DOMContentLoaded", function () {
  // View selector buttons
  const viewButtons = document.querySelectorAll(".view-btn");
  if (viewButtons.length) {
    viewButtons.forEach((btn) => {
      btn.addEventListener("click", function () {
        const view = this.dataset.view;
        switchBookingView(view);
      });
    });
  }

  // Calendar navigation buttons
  const prevMonthBtn = document.getElementById("prev-month-btn");
  const nextMonthBtn = document.getElementById("next-month-btn");
  const todayBtn = document.getElementById("today-btn");

  if (prevMonthBtn) {
    prevMonthBtn.addEventListener("click", function () {
      currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
      renderCalendar();
    });
  }

  if (nextMonthBtn) {
    nextMonthBtn.addEventListener("click", function () {
      currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
      renderCalendar();
    });
  }

  if (todayBtn) {
    todayBtn.addEventListener("click", function () {
      currentCalendarDate = new Date();
      renderCalendar();
    });
  }

  // Day details modal
  const dayDetailsModal = document.getElementById("day-details-modal");
  if (dayDetailsModal) {
    // Close button for day details modal
    const closeBtn = dayDetailsModal.querySelector(".close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        dayDetailsModal.classList.remove("show");
      });
    }

    // New booking for specific day button
    const newBookingForDayBtn = document.getElementById(
      "new-booking-for-day-btn",
    );
    if (newBookingForDayBtn) {
      newBookingForDayBtn.addEventListener("click", function () {
        const selectedDate =
          document.getElementById("selected-date").dataset.date;
        dayDetailsModal.classList.remove("show");
        showNewBookingModalForDate(selectedDate);
      });
    }
  }
});

// Switch between list and calendar view
function switchBookingView(view) {
  // Update view buttons
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.classList.remove("active");
  });
  document
    .querySelector(`.view-btn[data-view="${view}"]`)
    .classList.add("active");

  // Update visible content
  const listContainer = document.getElementById("bookings-list");
  const calendarContainer = document.getElementById("bookings-calendar-view");

  if (view === "list") {
    listContainer.classList.remove("hidden");
    calendarContainer.classList.add("hidden");
    currentCalendarView = "list";
  } else {
    listContainer.classList.add("hidden");
    calendarContainer.classList.remove("hidden");
    currentCalendarView = "calendar";

    // Generate the calendar if it's now visible
    renderCalendar();
  }
}

function renderCalendar() {
  const calendarTitle = document.getElementById("calendar-title");
  const calendarDaysGrid = document.getElementById("calendar-days-grid");

  if (!calendarTitle || !calendarDaysGrid) return;

  // Set the calendar title (Month Year)
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  calendarTitle.textContent = `${
    monthNames[currentCalendarDate.getMonth()]
  } ${currentCalendarDate.getFullYear()}`;

  // Clear the calendar grid
  calendarDaysGrid.innerHTML = "";

  // Calculate the first day of the month
  const firstDay = new Date(
    currentCalendarDate.getFullYear(),
    currentCalendarDate.getMonth(),
    1,
  );
  const lastDay = new Date(
    currentCalendarDate.getFullYear(),
    currentCalendarDate.getMonth() + 1,
    0,
  );

  // Get the day of the week for the first day (0 = Sunday, 1 = Monday, etc.)
  const startingDay = firstDay.getDay();

  // Get the number of days in the previous month
  const prevMonthLastDay = new Date(
    currentCalendarDate.getFullYear(),
    currentCalendarDate.getMonth(),
    0,
  ).getDate();

  // Filter bookings for the current month and adjacent days
  const currentMonthBookings = getCurrentMonthBookings();

  // Get today's date for highlighting
  const today = new Date();
  const todayDate = today.getDate();
  const todayMonth = today.getMonth();
  const todayYear = today.getFullYear();

  // Create days from previous month to fill the first row
  for (let i = 0; i < startingDay; i++) {
    const day = prevMonthLastDay - startingDay + i + 1;
    const date = new Date(
      currentCalendarDate.getFullYear(),
      currentCalendarDate.getMonth() - 1,
      day,
    );
    const dateStr = formatDateForAPI(date);

    // Get bookings for this day
    const dayBookings = currentMonthBookings.filter((booking) =>
      isDateInBookingRange(
        dateStr,
        booking.check_in_date,
        booking.check_out_date,
      ),
    );

    calendarDaysGrid.appendChild(
      createDayElement(day, dayBookings, "different-month", dateStr),
    );
  }

  // Create days for current month
  for (let day = 1; day <= lastDay.getDate(); day++) {
    const date = new Date(
      currentCalendarDate.getFullYear(),
      currentCalendarDate.getMonth(),
      day,
    );
    const dateStr = formatDateForAPI(date);

    // Get bookings for this day
    const dayBookings = currentMonthBookings.filter((booking) =>
      isDateInBookingRange(
        dateStr,
        booking.check_in_date,
        booking.check_out_date,
      ),
    );

    // Check if this is today
    const isToday =
      day === todayDate &&
      currentCalendarDate.getMonth() === todayMonth &&
      currentCalendarDate.getFullYear() === todayYear;

    calendarDaysGrid.appendChild(
      createDayElement(day, dayBookings, isToday ? "today" : "", dateStr),
    );
  }

  // Calculate how many days from the next month to show to complete the grid
  // We want to have complete weeks, so the total should be a multiple of 7
  const totalDaysShown = startingDay + lastDay.getDate();
  const remainingCells = 7 - (totalDaysShown % 7);

  // Only add next month days if needed (if we're not already at the end of a week)
  if (remainingCells < 7) {
    // Create days from next month
    for (let day = 1; day <= remainingCells; day++) {
      const date = new Date(
        currentCalendarDate.getFullYear(),
        currentCalendarDate.getMonth() + 1,
        day,
      );
      const dateStr = formatDateForAPI(date);

      // Get bookings for this day
      const dayBookings = currentMonthBookings.filter((booking) =>
        isDateInBookingRange(
          dateStr,
          booking.check_in_date,
          booking.check_out_date,
        ),
      );

      calendarDaysGrid.appendChild(
        createDayElement(day, dayBookings, "different-month", dateStr),
      );
    }
  }

  // Optimize display based on screen size
  optimizeCalendarForScreenSize();
}

function createDayElement(dayNumber, bookings, extraClass, dateStr) {
  const dayElement = document.createElement("div");
  dayElement.className = `calendar-day ${extraClass || ""}`;
  dayElement.dataset.date = dateStr;

  // Filter active bookings (not cancelled)
  const activeBookings = bookings.filter((b) => b.status !== "cancelled");
  const confirmedBookings = activeBookings.filter(
    (b) => b.status === "confirmed",
  );
  const checkedInBookings = activeBookings.filter(
    (b) => b.status === "checked_in",
  );

  // Add classes for styling based on bookings
  if (confirmedBookings.length > 0) {
    dayElement.classList.add("has-bookings");
  }

  if (checkedInBookings.length > 0) {
    dayElement.classList.add("has-checkins");
  }

  // Create day number
  const dayNumberEl = document.createElement("div");
  dayNumberEl.className = "day-number";
  dayNumberEl.textContent = dayNumber;
  dayElement.appendChild(dayNumberEl);

  // Add booking count if there are any active bookings
  if (activeBookings.length > 0) {
    const bookingCount = document.createElement("div");
    bookingCount.className = `booking-count ${
      activeBookings.length > 1 ? "has-multiple" : ""
    }`;
    bookingCount.textContent = `${activeBookings.length} booking${
      activeBookings.length !== 1 ? "s" : ""
    }`;
    dayElement.appendChild(bookingCount);

    // Show preview of first bookings (limit based on screen size)
    // Initially show up to 2, this will be adjusted by optimizeCalendarForScreenSize
    const maxPreviewsToShow = Math.min(2, activeBookings.length);

    for (let i = 0; i < maxPreviewsToShow; i++) {
      const booking = activeBookings[i];
      const bookingPreview = document.createElement("div");
      bookingPreview.className = `day-booking-preview ${
        booking.status === "checked_in" ? "checked-in" : ""
      }`;
      bookingPreview.textContent = `${booking.room}: ${booking.guest_name}`;
      dayElement.appendChild(bookingPreview);
    }

    // If there are more bookings than we're showing, add indicator
    if (activeBookings.length > maxPreviewsToShow) {
      const moreBookings = document.createElement("div");
      moreBookings.className = "day-booking-preview more-indicator";
      moreBookings.textContent = `+${
        activeBookings.length - maxPreviewsToShow
      } more`;
      dayElement.appendChild(moreBookings);
    }
  }

  // Add click event to show day details
  dayElement.addEventListener("click", function () {
    showDayDetails(dateStr, bookings);
  });

  return dayElement;
}

// Show modal with day details
function showDayDetails(dateStr, bookings) {
  const modal = document.getElementById("day-details-modal");
  const dateTitle = document.getElementById("selected-date");
  const bookingsList = document.getElementById("day-bookings-list");

  if (!modal || !dateTitle || !bookingsList) return;

  // Format date for display
  const selectedDate = new Date(dateStr);
  const formattedDate = formatDateForDisplay(selectedDate);

  // Set the date
  dateTitle.textContent = formattedDate;
  dateTitle.dataset.date = dateStr;

  // Clear previous bookings
  bookingsList.innerHTML = "";

  // Add bookings or show empty state
  if (bookings.length === 0) {
    bookingsList.innerHTML = `
      <div class="empty-state" style="padding: 2rem;">
        <i class="fas fa-calendar-day fa-3x"></i>
        <p>No bookings for this date</p>
      </div>
    `;
  } else {
    // Sort bookings by room number AND check-in time
    bookings.sort((a, b) => {
      const timeA = a.check_in_time || "14:00";
      const timeB = b.check_in_time || "14:00";

      // First sort by time
      const timeCompare = timeA.localeCompare(timeB);
      if (timeCompare !== 0) return timeCompare;

      // If same time, sort by room number
      return parseInt(a.room) - parseInt(b.room);
    });

    // Add each booking
    bookings.forEach((booking) => {
      const bookingItem = document.createElement("div");
      bookingItem.className = "day-booking-item";
      bookingItem.dataset.id = booking.booking_id;

      const checkInDate = new Date(booking.check_in_date);
      const checkOutDate = new Date(booking.check_out_date);
      const isCheckIn = formatDateForAPI(checkInDate) === dateStr;
      const isCheckOut = formatDateForAPI(checkOutDate) === dateStr;

      // Format check-in time
      const checkInTime = booking.check_in_time || "14:00";
      const formattedTime = formatTime(checkInTime);

      // Calculate status badge text
      let statusText =
        booking.status.charAt(0).toUpperCase() + booking.status.slice(1);
      if (isCheckIn && booking.status === "confirmed") {
        statusText = "Arriving";
      } else if (booking.status === "checked_in" && !isCheckOut) {
        statusText = "Checked In";
      } else if (
        isCheckOut &&
        (booking.status === "confirmed" || booking.status === "checked_in")
      ) {
        statusText = "Check-out Day";
      }

      // Determine what to show in the time section
      let timeDisplay = "";
      if (isCheckIn) {
        timeDisplay = `<div class="day-booking-time-info">
          <i class="fas fa-clock"></i> Expected: ${formattedTime}
        </div>`;
      } else if (isCheckOut) {
        timeDisplay = `<div class="day-booking-time-info checkout">
          <i class="fas fa-door-open"></i> Check-out
        </div>`;
      } else {
        timeDisplay = `<div class="day-booking-time-info staying">
          <i class="fas fa-bed"></i> Staying
        </div>`;
      }

      const acBadge = booking.is_ac
        ? `<span class="day-bk-ac" title="AC Room">❄️</span>`
        : "";

      bookingItem.innerHTML = `
        <div class="day-booking-header">
          <div class="day-booking-room">Room ${booking.room}${acBadge}</div>
          ${timeDisplay}
        </div>
        <div class="day-booking-guest">${booking.guest_name}</div>
        <div class="day-booking-status">
          <div class="day-booking-status-badge ${booking.status}">
            ${statusText}
          </div>
          <div class="day-booking-price">₹${booking.total_amount}</div>
        </div>
      `;

      // Add click event to show booking details
      bookingItem.addEventListener("click", function () {
        modal.classList.remove("show");
        showBookingDetails(booking.booking_id);
      });

      bookingsList.appendChild(bookingItem);
    });
  }

  // Show the modal
  modal.classList.add("show");
}

// Show new booking modal with a specific date pre-selected
function showNewBookingModalForDate(dateStr) {
  const modal = document.getElementById("new-booking-modal");
  if (!modal) return;

  // Reset form
  const form = document.getElementById("booking-form");
  if (form) form.reset();

  // Set the selected date
  const checkInDate = document.getElementById("booking-check-in");
  const checkOutDate = document.getElementById("booking-check-out");
  const checkInTimeInput = document.getElementById("booking-check-in-time");

  if (checkInDate) {
    checkInDate.value = dateStr;
  }

  // Set check-out date to the next day by default
  const nextDay = new Date(dateStr);
  nextDay.setDate(nextDay.getDate() + 1);
  if (checkOutDate) {
    checkOutDate.value = formatDateForAPI(nextDay);
  }

  // Reflect the same range in the visible flatpickr field — the two
  // hidden inputs above are what the form actually submits, but without
  // this the date-range box still shows its "Select dates" placeholder,
  // which reads as "nothing was preset" even though it was.
  if (window.bookingDatePicker) {
    // Third arg tells flatpickr to parse these as Y-m-d — without it, it
    // tries to parse them using the picker's DISPLAY format ("D, d M"),
    // fails silently, and the visible field is left showing "Select
    // dates" even though the hidden inputs above are correct.
    window.bookingDatePicker.setDate(
      [dateStr, formatDateForAPI(nextDay)], true, "Y-m-d"
    );
  }

  // Set default check-in time to 2:00 PM
  if (checkInTimeInput) {
    checkInTimeInput.value = "14:00"; // 2:00 PM
  }

  // Reset room select
  const roomSelect = document.getElementById("booking-room");
  if (roomSelect)
    roomSelect.innerHTML = '<option value="">Checking availability...</option>';

  // Reset payment method
  document.querySelectorAll("#booking-form .payment-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  const cashBtn = document.querySelector("#booking-form .payment-btn.cash");
  if (cashBtn) cashBtn.classList.add("active");

  const paymentMethodInput = document.getElementById("booking-payment-method");
  if (paymentMethodInput) paymentMethodInput.value = "cash";

  // Reset photo preview
  const photoPreviewContainer = document.getElementById(
    "booking-photo-preview-container",
  );
  if (photoPreviewContainer) photoPreviewContainer.style.display = "none";

  uploadedPhotoUrl = null;

  // Check availability for the selected date
  checkAvailability();

  // Show modal
  modal.classList.add("show");
}

// Get bookings for the current month view
function getCurrentMonthBookings() {
  // Get the start and end dates for the calendar view (including adjacent months' days)
  const startDate = new Date(
    currentCalendarDate.getFullYear(),
    currentCalendarDate.getMonth(),
    1,
  );
  startDate.setDate(1 - startDate.getDay()); // Go back to the first day shown on the calendar

  const endDate = new Date(
    currentCalendarDate.getFullYear(),
    currentCalendarDate.getMonth() + 1,
    0,
  );
  const daysAfter = 6 - endDate.getDay();
  endDate.setDate(endDate.getDate() + daysAfter); // Go forward to the last day shown on the calendar

  // Format dates for comparison
  const startDateStr = formatDateForAPI(startDate);
  const endDateStr = formatDateForAPI(endDate);

  // Filter bookings that fall within our calendar view
  return bookings.filter((booking) => {
    const bookingCheckIn = booking.check_in_date;
    const bookingCheckOut = booking.check_out_date;

    // A booking is in our view if:
    // 1. Check-in date is before or equal to the end date of our calendar, AND
    // 2. Check-out date is after or equal to the start date of our calendar
    return bookingCheckIn <= endDateStr && bookingCheckOut >= startDateStr;
  });
}

// Check if a date falls within a booking's date range
function isDateInBookingRange(dateStr, checkInDate, checkOutDate) {
  // Convert to comparable format
  const date = new Date(dateStr);
  const checkIn = new Date(checkInDate);
  const checkOut = new Date(checkOutDate);

  // Reset time components for accurate date comparison
  date.setHours(0, 0, 0, 0);
  checkIn.setHours(0, 0, 0, 0);
  checkOut.setHours(0, 0, 0, 0);

  // A date is in the booking range if:
  // It's on or after the check-in date AND before the check-out date
  // (check-out day itself is not considered part of the stay)
  return date >= checkIn && date < checkOut;
}

// Format date for API (YYYY-MM-DD)
function formatDateForAPI(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Format date for display
function formatDateForDisplay(date) {
  const options = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  return date.toLocaleDateString("en-US", options);
}

// Check availability for a specific date
async function checkAvailabilityForDate(dateStr) {
  try {
    // Create a next day date for check_out_date
    const checkInDate = new Date(dateStr);
    const checkOutDate = new Date(dateStr);
    checkOutDate.setDate(checkOutDate.getDate() + 1);

    const response = await apiFetch("/check_availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        check_in_date: formatDateForAPI(checkInDate),
        check_out_date: formatDateForAPI(checkOutDate),
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with status: ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      return result.available_rooms;
    } else {
      console.error(result.message || "Error checking availability");
      return [];
    }
  } catch (error) {
    console.error("Error checking availability:", error);
    return [];
  }
}

// Update the original fetchBookings function to also update the calendar
const originalFetchBookings = fetchBookings;
fetchBookings = async function () {
  await originalFetchBookings();

  // If we're in calendar view, refresh the calendar
  if (currentCalendarView === "calendar") {
    renderCalendar();
  }
};

// ─── Real-time booking sync ────────────────────────────────────────────────
// Debounce so rapid Firestore changes don't trigger back-to-back fetches.
let _bookingRefreshTimer = null;
function _debouncedFetchBookings(delayMs = 800) {
  clearTimeout(_bookingRefreshTimer);
  _bookingRefreshTimer = setTimeout(() => {
    // Only re-fetch when the bookings tab is actually visible.
    // If the tab is hidden, just mark stale so the next tab-open triggers a fresh load.
    const bookingsTab = document.getElementById("bookings-tab");
    if (bookingsTab && !bookingsTab.classList.contains("hidden")) {
      fetchBookings();
    } else {
      // Flag stale — fetchBookings() is already called on every tab open (line 29)
      console.log("⚡ Booking change received — will refresh on next tab open");
    }
  }, delayMs);
}

window.addEventListener("cibaraBookingAdded",    () => _debouncedFetchBookings());
window.addEventListener("cibaraBookingModified", () => _debouncedFetchBookings());
// Optimize the calendar layout for laptop screens
function optimizeCalendarForScreenSize() {
  // Get the container width
  const calendarContainer = document.getElementById("bookings-calendar-view");
  if (!calendarContainer) return;

  // Get current viewport width
  const viewportWidth = window.innerWidth;

  // Apply different styles based on screen size
  if (viewportWidth < 1366) {
    // For standard laptops (1366x768 is common)
    document.documentElement.style.setProperty(
      "--calendar-day-min-height",
      "55px",
    );
    document.documentElement.style.setProperty(
      "--calendar-day-aspect-ratio",
      "1/0.75",
    );
  } else if (viewportWidth < 1600) {
    // For larger laptops
    document.documentElement.style.setProperty(
      "--calendar-day-min-height",
      "65px",
    );
    document.documentElement.style.setProperty(
      "--calendar-day-aspect-ratio",
      "1/0.8",
    );
  } else {
    // For desktops or large screens
    document.documentElement.style.setProperty(
      "--calendar-day-min-height",
      "70px",
    );
    document.documentElement.style.setProperty(
      "--calendar-day-aspect-ratio",
      "1/0.85",
    );
  }

  // Limit the maximum number of booking previews based on cell height
  const calendarDays = document.querySelectorAll(".calendar-day");
  calendarDays.forEach((day) => {
    const dayHeight = day.offsetHeight;
    const bookingPreviews = day.querySelectorAll(".day-booking-preview");

    // Show only as many previews as can fit
    const maxPreviews = Math.floor((dayHeight - 30) / 18); // Approximate calculation
    bookingPreviews.forEach((preview, index) => {
      if (index < maxPreviews) {
        preview.style.display = "block";
      } else {
        preview.style.display = "none";
      }
    });
  });
}

// Add the optimization function to the calendar rendering
const originalRenderCalendar = renderCalendar;
renderCalendar = function () {
  originalRenderCalendar();
  setTimeout(optimizeCalendarForScreenSize, 100); // Run after the calendar is rendered
};

// Run optimization on window resize
window.addEventListener("resize", function () {
  if (currentCalendarView === "calendar") {
    optimizeCalendarForScreenSize();
  }
});

// Update switchBookingView to call optimization when switching to calendar
const originalSwitchBookingView = switchBookingView;
switchBookingView = function (view) {
  originalSwitchBookingView(view);
  if (view === "calendar") {
    setTimeout(optimizeCalendarForScreenSize, 100);
  }
};
function optimizeCalendarForScreenSize() {
  // Get current viewport width
  const viewportWidth = window.innerWidth;

  // Default values for calendar day cells based on screen size
  let minHeight, aspectRatio, maxPreviews;

  if (viewportWidth >= 1600) {
    // Large desktops
    minHeight = "75px";
    aspectRatio = "1/0.85";
    maxPreviews = 3;
  } else if (viewportWidth >= 1366) {
    // Standard laptops
    minHeight = "65px";
    aspectRatio = "1/0.8";
    maxPreviews = 2;
  } else if (viewportWidth >= 992) {
    // Small laptops
    minHeight = "60px";
    aspectRatio = "1/0.75";
    maxPreviews = 1;
  } else if (viewportWidth >= 768) {
    // Tablets
    minHeight = "55px";
    aspectRatio = "1/0.7";
    maxPreviews = 1;
  } else {
    // Mobile
    minHeight = "50px";
    aspectRatio = "auto";
    maxPreviews = 0; // No previews on mobile
  }

  // Set CSS variables
  document.documentElement.style.setProperty(
    "--calendar-day-min-height",
    minHeight,
  );
  document.documentElement.style.setProperty(
    "--calendar-day-aspect-ratio",
    aspectRatio,
  );

  // Adjust visible previews
  const dayElements = document.querySelectorAll(".calendar-day");

  dayElements.forEach((day) => {
    const previews = day.querySelectorAll(
      ".day-booking-preview:not(.more-indicator)",
    );
    const moreIndicator = day.querySelector(".more-indicator");

    // Hide extra previews based on screen size
    previews.forEach((preview, index) => {
      if (index < maxPreviews) {
        preview.style.display = "block";
      } else {
        preview.style.display = "none";
      }
    });

    // Update more indicator
    if (moreIndicator && previews.length > maxPreviews) {
      moreIndicator.style.display = "block";
      moreIndicator.textContent = `+${previews.length - maxPreviews} more`;
    } else if (moreIndicator) {
      moreIndicator.style.display = "none";
    }
  });
}

// Listen for window resize to optimize calendar
window.addEventListener("resize", function () {
  if (currentCalendarView === "calendar") {
    optimizeCalendarForScreenSize();
  }
});

// ── WhatsApp booking confirmation ───────────────────────────────────────────
// One message per *stay*, not per room. A multi-room booking (rooms sharing a
// group_booking_id — see /create_multi_booking in routes/bookings.py) produces
// a single combined confirmation listing every room; an ordinary booking
// produces the usual single-room message. Messages are handed to wa.me rather
// than sent server-side, so the manager sends them from their own WhatsApp.

const WA_MAPS_LINK = "https://maps.app.goo.gl/Mz5rTrvC3ctyMmUt5";

// 10-digit Indian mobile -> wa.me form. Tolerates +91/0/spaces/dashes.
function _waNormalisePhone(mobile) {
  let phone = String(mobile || "").trim().replace(/[^\d+]/g, "");
  phone = phone.replace(/^\+/, "");
  if (phone.startsWith("0")) phone = phone.substring(1);
  if (!phone.startsWith("91")) phone = `91${phone}`;
  return phone;
}

function _waFmtDate(d) {
  return d
    ? new Date(d + "T00:00:00").toLocaleDateString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";
}

function _waFmtTime(t) {
  if (!t) return "2:00 PM";
  const [h, m] = String(t).split(":");
  const hr = parseInt(h, 10);
  if (isNaN(hr)) return "2:00 PM";
  const ampm = hr >= 12 ? "PM" : "AM";
  return `${hr % 12 || 12}:${m} ${ampm}`;
}

function _waNights(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  return Math.round(
    (new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24),
  );
}

function _waReminders(showAdvanceNote) {
  return [
    "🔔 *Important Reminders:*",
    "• Please carry a valid govt. photo ID (Aadhaar / Passport / DL)",
    "• Room number is subject to availability and may change on arrival",
    showAdvanceNote ? "• Advance amount paid is non-refundable" : null,
    "• We offer *24-hour checkout* — check-out time matches your check-in time",
    "• Contact us if you need any assistance",
  ]
    .filter(Boolean)
    .join("\n");
}

function _waOpen(phone, message) {
  window.open(
    `https://wa.me/${phone}?text=${encodeURIComponent(message)}`,
    "_blank",
  );
  showNotification("✅ Opening WhatsApp...", "success");
}

// ── Message builders ────────────────────────────────────────────────────────

function _waSingleBookingMessage(bk) {
  const bookingId =
    bk.booking_id ||
    document.getElementById("details-booking-id")?.textContent ||
    "";
  const guestName =
    bk.guest_name ||
    document.getElementById("details-guest-name")?.textContent ||
    "";
  const room =
    bk.room || document.getElementById("details-room-number")?.textContent || "";
  const guestCount = bk.guest_count || 1;
  const src = bk.booking_source || "normal";

  const nights = _waNights(bk.check_in_date, bk.check_out_date);
  const nightsText = nights > 0 ? `${nights} night${nights !== 1 ? "s" : ""}` : "—";
  const acLine = bk.is_ac === true ? "\n• Room Type: ❄️ AC Room" : "";

  const ratePerNight = bk.rate_per_night || 0;
  const totalAmount = bk.total_amount || 0;
  const paidAmount = bk.paid_amount || 0;
  const balance = bk.balance != null ? bk.balance : totalAmount - paidAmount;

  const isOta = isOtaPrepaid(src);
  let paymentSection;
  if (isOta) {
    paymentSection = `

🏷️ *Booking Source:* ${otaSourceLabel(src)} (Prepaid)
• Payment already settled via ${otaSourceLabel(src)}`;
  } else {
    const rateLineStr =
      ratePerNight > 0 && nights > 0
        ? `\n• Rate: ₹${ratePerNight}/night × ${nights} night${nights !== 1 ? "s" : ""} = ₹${totalAmount}`
        : `\n• Total Amount: ₹${totalAmount}`;
    paymentSection = `

💰 *Payment Details:*${rateLineStr}
• Advance Paid: ₹${paidAmount}
• Balance Due at Check-in: ₹${balance > 0 ? balance : 0}`;
  }

  return `🏨 *CIBARA COMFORTS — BOOKING CONFIRMED* ✅

Namaste ${guestName}! 🙏

We're delighted to confirm your reservation. Here are your booking details:

🛏️ *Stay Details:*
• Booking ID: #${String(bookingId).substring(0, 8).toUpperCase()}
• Room: ${room}${acLine}
• Guests: ${guestCount} guest${guestCount !== 1 ? "s" : ""}
• Check-in: 📅 ${_waFmtDate(bk.check_in_date)}
• ⏰ Approx. Arrival Time: ${_waFmtTime(bk.check_in_time || "14:00")}
• Check-out: 📅 ${_waFmtDate(bk.check_out_date)}
• Duration: 🌙 ${nightsText}${paymentSection}

📍 *Find Us Here:*
${WA_MAPS_LINK}

${_waReminders(!isOta && paidAmount > 0)}

We look forward to hosting you! 😊
For any queries, reply to this message.

— *Team Cibara Comforts*`;
}

// One message covering every room in a multi-room booking. `lead` is the
// member whose guest is being addressed (the picked recipient).
function _waGroupBookingMessage(members, lead) {
  const first = members[0];
  const nights = _waNights(first.check_in_date, first.check_out_date);
  const nightsText = nights > 0 ? `${nights} night${nights !== 1 ? "s" : ""}` : "—";

  const grandTotal = members.reduce((s, m) => s + (m.total_amount || 0), 0);
  const grandPaid = members.reduce((s, m) => s + (m.paid_amount || 0), 0);
  const grandBalance = members.reduce(
    (s, m) =>
      s +
      (m.balance != null ? m.balance : (m.total_amount || 0) - (m.paid_amount || 0)),
    0,
  );
  const totalGuests = members.reduce((s, m) => s + (m.guest_count || 1), 0);

  // Only repeat the per-room guest name when the rooms are under different
  // names — for a single-organiser group it is noise.
  const distinctNames = new Set(
    members.map((m) => String(m.guest_name || "").trim().toLowerCase()),
  );
  const showPerRoomNames = distinctNames.size > 1;

  const roomLines = members
    .map((m, i) => {
      const ac = m.is_ac ? " ❄️" : "";
      const who = showPerRoomNames ? ` — ${m.guest_name}` : "";
      const guests = ` — ${m.guest_count || 1} guest${(m.guest_count || 1) !== 1 ? "s" : ""}`;
      const amount = ` — ₹${m.total_amount || 0}`;
      return `${i + 1}. Room ${m.room}${ac}${who}${guests}${amount}`;
    })
    .join("\n");

  const groupRef = String(first.group_booking_id || "").substring(0, 8).toUpperCase();

  return `🏨 *CIBARA COMFORTS — BOOKING CONFIRMED* ✅

Namaste ${lead.guest_name}! 🙏

We're delighted to confirm your reservation for *${members.length} rooms*.

🛏️ *Your Rooms:*
${roomLines}

📅 *Stay Details:*
• Booking Ref: #${groupRef}
• Check-in: 📅 ${_waFmtDate(first.check_in_date)}
• ⏰ Approx. Arrival Time: ${_waFmtTime(first.check_in_time || "14:00")}
• Check-out: 📅 ${_waFmtDate(first.check_out_date)}
• Duration: 🌙 ${nightsText}
• Total Guests: ${totalGuests}

💰 *Payment Details (all rooms):*
• Grand Total: ₹${grandTotal}
• Advance Paid: ₹${grandPaid}
• Balance Due at Check-in: ₹${grandBalance > 0 ? grandBalance : 0}

📍 *Find Us Here:*
${WA_MAPS_LINK}

${_waReminders(grandPaid > 0)}

We look forward to hosting you! 😊
For any queries, reply to this message.

— *Team Cibara Comforts*`;
}

// ── Entry point (wired to the WA button in the booking details modal) ───────

function sendWhatsAppBookingConfirmation() {
  try {
    const bk = _activeBookingForWhatsApp || {};
    const members = getBookingGroupMembers(bk);

    // Single room — unchanged behaviour.
    if (members.length <= 1) {
      const mobile =
        bk.guest_mobile ||
        document.getElementById("details-guest-mobile")?.textContent ||
        "";
      if (!String(mobile).trim()) {
        showNotification("Phone number not available", "error");
        return;
      }
      _waOpen(_waNormalisePhone(mobile), _waSingleBookingMessage(bk));
      return;
    }

    // Multi-room group — one combined message. Group the members by contact
    // number; if the whole group shares one number there is nothing to ask.
    const byMobile = new Map();
    members.forEach((m) => {
      const key = _waNormalisePhone(m.guest_mobile);
      if (!key || key === "91") return;
      if (!byMobile.has(key)) byMobile.set(key, []);
      byMobile.get(key).push(m);
    });

    if (byMobile.size === 0) {
      showNotification("No phone number on any room in this group", "error");
      return;
    }

    if (byMobile.size === 1) {
      const [phone, rooms] = byMobile.entries().next().value;
      _waOpen(phone, _waGroupBookingMessage(members, rooms[0]));
      return;
    }

    _waShowGroupRecipientPicker(members, byMobile, _waNormalisePhone(bk.guest_mobile));
  } catch (error) {
    console.error("Error sending WhatsApp confirmation:", error);
    showNotification("Error preparing message: " + error.message, "error");
  }
}

// Rooms in a group can be under different names/numbers. Rather than guessing
// or falling back to one message per room, ask which single contact should
// receive the combined confirmation.
function _waShowGroupRecipientPicker(members, byMobile, defaultPhone) {
  const modal = document.getElementById("wa-group-recipient-modal");
  const list = document.getElementById("wa-group-recipient-list");
  if (!modal || !list) {
    // Fall back to the currently open booking's contact rather than blocking.
    const fallback = defaultPhone || byMobile.keys().next().value;
    const lead = (byMobile.get(fallback) || members)[0];
    _waOpen(fallback, _waGroupBookingMessage(members, lead));
    return;
  }

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);

  list.innerHTML = "";
  byMobile.forEach((rooms, phone) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "bk-recipient-btn" + (phone === defaultPhone ? " bk-recipient-default" : "");
    btn.innerHTML =
      `<span><span class="bk-recipient-name">${esc(rooms[0].guest_name)}</span>` +
      `<span class="bk-recipient-meta">${esc(rooms[0].guest_mobile)} · ` +
      `Room${rooms.length !== 1 ? "s" : ""} ${rooms.map((r) => esc(r.room)).join(", ")}</span></span>` +
      `<i class="fab fa-whatsapp" style="color:#25d366;font-size:1.15rem;"></i>`;
    btn.addEventListener("click", () => {
      modal.classList.remove("show");
      _waOpen(phone, _waGroupBookingMessage(members, rooms[0]));
    });
    list.appendChild(btn);
  });

  modal.classList.add("show");
}

// ─── MMT Settlements View ───────────────────────────────────────────────────

// Cache fetched data so tab switches don't re-fetch
let _mmtUnsettled  = null;
let _mmtSettled    = null;
let _mmtActiveTab  = "pending";

// ── Settlement card helpers ────────────────────────────────────────────────
// Platform chip (MMT orange / Agoda purple).
function _otaPlatChip(plat) {
  if (!plat) return "";
  const ag = plat === "agoda";
  return `<span style="font-size:0.66rem;font-weight:700;text-transform:uppercase;letter-spacing:0.02em;padding:1px 6px;border-radius:6px;margin-left:6px;${
    ag ? "background:#ede9fe;color:#6d28d9;" : "background:#fff1e6;color:#c2410c;"
  }">${otaSourceLabel(plat)}</span>`;
}
// How the settlement was recorded: bank PDF auto-match, settlement email, or manual.
function _settleSourcePill(src) {
  const map = {
    bank_pdf: ["Auto · bank", "#dcfce7", "#15803d"],
    email:    ["Auto · email", "#dbeafe", "#1d4ed8"],
    manual:   ["Manual", "#f1f5f9", "#475569"],
  };
  const [label, bg, fg] = map[src] || ["Manual", "#f1f5f9", "#475569"];
  return `<span style="font-size:0.66rem;font-weight:600;padding:1px 7px;border-radius:6px;background:${bg};color:${fg};white-space:nowrap;">${label}</span>`;
}
// Whole days since an ISO date (used to show how long a payout has been due).
function _daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

async function showMmtSettlementsModal() {
  const modal  = document.getElementById("mmt-settlements-modal");
  const listEl = document.getElementById("mmt-settlements-list");
  if (!modal || !listEl) return;

  // Reset cache on each open so data is always fresh
  _mmtUnsettled = null;
  _mmtSettled   = null;
  _mmtActiveTab = "pending";

  modal.classList.add("show");
  _mmtSetActiveTab("pending");

  // Wire up tab buttons (safe to call multiple times — replaces listeners)
  document.querySelectorAll(".mmt-tab-btn").forEach((btn) => {
    btn.onclick = () => _mmtSetActiveTab(btn.dataset.tab);
  });
}

function _mmtSetActiveTab(tab) {
  _mmtActiveTab = tab;

  // Update tab styling
  document.querySelectorAll(".mmt-tab-btn").forEach((btn) => {
    const isActive = btn.dataset.tab === tab;
    btn.style.color        = isActive ? "#0c6fcd" : "var(--text-secondary)";
    btn.style.borderBottom = isActive ? "2px solid #0c6fcd" : "2px solid transparent";
  });

  if (tab === "pending") {
    _mmtRenderPending();
  } else {
    _mmtRenderReceived();
  }
}

async function _mmtRenderPending() {
  const listEl = document.getElementById("mmt-settlements-list");
  if (!listEl) return;

  if (!_mmtUnsettled) {
    listEl.innerHTML = `<div class="loading-indicator"><span class="loader"></span><p>Loading...</p></div>`;
    try {
      const res  = await apiFetch("/get_mmt_unsettled");
      const data = await res.json();
      _mmtUnsettled = data.success ? (data.unsettled || []) : [];
    } catch (e) {
      listEl.innerHTML = `<p style="color:var(--danger);text-align:center;padding:1rem;">Error: ${e.message}</p>`;
      return;
    }
  }

  // Update badge
  const badge = document.getElementById("mmt-pending-badge");
  if (badge) {
    if (_mmtUnsettled.length > 0) {
      badge.textContent = _mmtUnsettled.length;
      badge.style.display = "inline";
    } else {
      badge.style.display = "none";
    }
  }

  if (_mmtUnsettled.length === 0) {
    listEl.innerHTML = `
      <div style="text-align:center;padding:2rem;color:var(--text-secondary);">
        <i class="fas fa-check-circle" style="font-size:2rem;margin-bottom:0.75rem;opacity:0.4;display:block;color:#16a34a;"></i>
        All OTA bookings are settled!
      </div>`;
    return;
  }

  const totalPending = _mmtUnsettled.reduce((s, b) => s + (b.net_receivable || 0), 0);

  let html = `
    <div style="display:flex;justify-content:space-between;align-items:center;
                background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);
                border-radius:8px;padding:0.6rem 0.85rem;margin-bottom:0.75rem;font-size:0.85rem;">
      <span style="color:var(--text-secondary);">${_mmtUnsettled.length} pending</span>
      <span style="font-weight:600;color:#d97706;">Expected: ₹${totalPending.toLocaleString("en-IN")}</span>
    </div>`;

  _mmtUnsettled.forEach((b) => {
    const net    = b.net_receivable != null ? `₹${Number(b.net_receivable).toLocaleString("en-IN")}` : "—";
    const checkin  = b.check_in_date  || "—";
    const checkout = b.check_out_date || "—";
    const plat   = b.platform || b.booking_source || "";
    const platChip = _otaPlatChip(plat);
    // How long the payout has been due (counted from check-out).
    const due = _daysSince(b.check_out_date);
    const ageChip = (due != null && due >= 0)
      ? `<span style="margin-left:auto;font-weight:600;color:${due > 14 ? "#b91c1c" : "#92400e"};white-space:nowrap;">
           <i class="fas fa-hourglass-half" style="margin-right:3px;"></i>${due}d due</span>`
      : "";

    html += `
      <div style="border:1px solid #fde68a;border-radius:8px;padding:0.65rem 0.85rem;
                  margin-bottom:0.5rem;background:#fffbeb;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.3rem;">
          <span style="font-weight:600;">${b.guest_name || "—"}${platChip}</span>
          <span style="font-weight:700;color:#d97706;">${net}</span>
        </div>
        <div style="display:flex;gap:0.9rem;font-size:0.78rem;color:var(--text-secondary);flex-wrap:wrap;align-items:center;margin-bottom:0.45rem;">
          <span><i class="fas fa-door-open" style="margin-right:3px;"></i>Room ${b.room || "—"}</span>
          <span><i class="fas fa-calendar-day" style="margin-right:3px;"></i>${checkin} → ${checkout}</span>
          ${ageChip}
        </div>
        <button
          onclick="document.getElementById('mmt-settlements-modal').classList.remove('show'); showBookingDetails('${b.booking_id}');"
          style="width:100%;padding:0.35rem;border-radius:6px;border:1px solid #f59e0b;
                 background:#fff;color:#b45309;font-size:0.78rem;font-weight:600;cursor:pointer;">
          <i class="fas fa-check" style="margin-right:4px;"></i>Mark Settlement Received
        </button>
      </div>`;
  });

  listEl.innerHTML = html;
}

async function _mmtRenderReceived() {
  const listEl = document.getElementById("mmt-settlements-list");
  if (!listEl) return;

  if (!_mmtSettled) {
    listEl.innerHTML = `<div class="loading-indicator"><span class="loader"></span><p>Loading...</p></div>`;
    try {
      const res  = await apiFetch("/get_ota_settlements");
      const data = await res.json();
      _mmtSettled = data.success ? (data.settlements || []) : [];
    } catch (e) {
      listEl.innerHTML = `<p style="color:var(--danger);text-align:center;padding:1rem;">Error: ${e.message}</p>`;
      return;
    }
  }

  if (_mmtSettled.length === 0) {
    listEl.innerHTML = `
      <div style="text-align:center;padding:2rem;color:var(--text-secondary);">
        <i class="fas fa-university" style="font-size:2rem;margin-bottom:0.75rem;opacity:0.4;display:block;"></i>
        No OTA settlements recorded yet.<br>
        <small>Use "Mark Settlement" in a booking's details once MMT / Agoda pays you.</small>
      </div>`;
    return;
  }

  const totalSettled = _mmtSettled.reduce((s, x) => s + (x.settlement_amount || 0), 0);
  // Per-platform breakdown (shown only when more than one platform appears).
  const byPlat = {};
  _mmtSettled.forEach((x) => {
    const p = x.platform || "other";
    byPlat[p] = (byPlat[p] || 0) + Number(x.settlement_amount || 0);
  });
  const platLine = Object.keys(byPlat).length > 1
    ? `<div style="display:flex;gap:0.85rem;font-size:0.72rem;color:var(--text-secondary);margin-top:0.4rem;flex-wrap:wrap;">
        ${Object.entries(byPlat).map(([p, amt]) =>
          `<span>${otaSourceLabel(p)}: <strong>₹${amt.toLocaleString("en-IN")}</strong></span>`).join("")}
       </div>`
    : "";

  let html = `
    <div style="background:rgba(12,111,205,0.07);border:1px solid rgba(12,111,205,0.2);
                border-radius:8px;padding:0.6rem 0.85rem;margin-bottom:0.75rem;font-size:0.85rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="color:var(--text-secondary);">${_mmtSettled.length} settlement${_mmtSettled.length !== 1 ? "s" : ""}</span>
        <span style="font-weight:600;color:#0c6fcd;">Total: ₹${totalSettled.toLocaleString("en-IN")}</span>
      </div>
      ${platLine}
    </div>`;

  _mmtSettled.forEach((s) => {
    const settled  = Number(s.settlement_amount || 0);
    const amount   = s.settlement_amount != null ? `₹${settled.toLocaleString("en-IN")}` : "—";
    const date     = s.settlement_date || s.created_at || "—";
    const utr      = s.utr || "";
    const plat     = s.platform || "";
    const platChip = _otaPlatChip(plat);
    const srcPill  = _settleSourcePill(s.source);

    // Gap between what was expected (net receivable) and what actually landed.
    const net = s.net_receivable != null ? Number(s.net_receivable) : null;
    let deltaChip = "";
    if (net != null && Math.abs(settled - net) > 1) {
      const d = settled - net;
      deltaChip = `<span title="Expected ₹${net.toLocaleString("en-IN")}"
        style="font-size:0.7rem;font-weight:600;color:${d < 0 ? "#b91c1c" : "#15803d"};white-space:nowrap;">
        ${d > 0 ? "+" : "−"}₹${Math.abs(d).toLocaleString("en-IN")} vs expected</span>`;
    }

    // Bottom line: UTR (bank reference) on the left, any gap on the right.
    const utrLine = (utr || deltaChip)
      ? `<div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.4rem;font-size:0.72rem;color:var(--text-secondary);">
           ${utr ? `<span><i class="fas fa-hashtag" style="margin-right:2px;"></i>UTR <span style="font-family:monospace;">${utr}</span></span>` : ""}
           ${deltaChip ? `<span style="margin-left:auto;">${deltaChip}</span>` : ""}
         </div>`
      : "";

    html += `
      <div style="border:1px solid var(--border);border-radius:8px;padding:0.65rem 0.85rem;
                  margin-bottom:0.5rem;background:var(--surface);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.3rem;">
          <span style="font-weight:600;">${s.guest_name || "—"}${platChip}</span>
          <span style="font-weight:700;color:var(--success);">${amount}</span>
        </div>
        <div style="display:flex;gap:0.9rem;font-size:0.78rem;color:var(--text-secondary);align-items:center;flex-wrap:wrap;">
          <span><i class="fas fa-door-open" style="margin-right:3px;"></i>Room ${s.room || "—"}</span>
          <span><i class="fas fa-calendar-check" style="margin-right:3px;"></i>Settled ${date}</span>
          <span style="margin-left:auto;">${srcPill}</span>
        </div>
        ${utrLine}
      </div>`;
  });

  listEl.innerHTML = html;
}

// ============================================================
// Arrivals Sheet — printable daily assignment + inspection checklist
// ------------------------------------------------------------
// Prints one page for a chosen date: every arrival with room, guest, contact
// and balance due, plus tick-boxes the manager fills in by hand (room ready,
// inspected, ID collected, keys handed). Optionally a departures section so
// the manager can see which rooms free up that day.
//
// The sheet is rendered into #booking-print-root (an otherwise-empty node at
// the end of templates/index.html) and revealed only by the @media print
// rules at the bottom of booking.css. Printing in-document rather than via
// window.open() avoids pop-up blockers and works on mobile browsers.
// ============================================================

function _bkEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// Local-date YYYY-MM-DD (toISOString would shift by the UTC offset).
function _bkYmd(date) {
  return (
    date.getFullYear() +
    "-" +
    String(date.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(date.getDate()).padStart(2, "0")
  );
}

function _bkLongDate(dateStr) {
  if (!dateStr) return "";
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function _bkShortDate(dateStr) {
  if (!dateStr) return "—";
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit", month: "short",
  });
}

function _bkRoomSort(a, b) {
  return String(a.room).localeCompare(String(b.room), undefined, { numeric: true });
}

// Arrivals = confirmed or already-checked-in bookings whose check-in is this
// date. Cancelled rooms are excluded — they must never reach the sheet.
function _bkArrivalsFor(dateStr) {
  return bookings
    .filter(
      (b) =>
        b.check_in_date === dateStr &&
        b.status !== "cancelled",
    )
    .sort(_bkRoomSort);
}

// Departures are the *expected* check-outs recorded on the booking. Actual
// checkout happens in the rooms module, so treat this as a planning hint.
function _bkDeparturesFor(dateStr) {
  return bookings
    .filter(
      (b) =>
        b.check_out_date === dateStr &&
        b.check_in_date !== dateStr &&
        (b.status === "confirmed" || b.status === "checked_in"),
    )
    .sort(_bkRoomSort);
}

function _bkArrivalsSelectedDate() {
  const input = document.getElementById("arrivals-sheet-date");
  return (input && input.value) || _bkYmd(new Date());
}

function renderArrivalsSheetPreview() {
  const box = document.getElementById("arrivals-sheet-preview");
  if (!box) return;
  const dateStr = _bkArrivalsSelectedDate();
  const arrivals = _bkArrivalsFor(dateStr);

  // Keep the quick chips in sync with whatever date is actually selected.
  const today = _bkYmd(new Date());
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = _bkYmd(tomorrowDate);
  document.querySelectorAll("[data-arrivals-preset]").forEach((chip) => {
    const want = chip.dataset.arrivalsPreset === "today" ? today : tomorrow;
    chip.classList.toggle("active", want === dateStr);
  });

  if (!arrivals.length) {
    box.innerHTML =
      '<div class="bk-preview-empty">No arrivals on ' +
      _bkEsc(_bkLongDate(dateStr)) +
      ". The sheet will still print with the departures section.</div>";
    return;
  }

  const guests = arrivals.reduce((s, b) => s + (b.guest_count || 1), 0);
  const balance = arrivals.reduce(
    (s, b) =>
      s +
      (isOtaPrepaid(b.booking_source)
        ? 0
        : b.balance != null
          ? b.balance
          : (b.total_amount || 0) - (b.paid_amount || 0)),
    0,
  );
  const groups = new Set(
    arrivals.filter((b) => b.group_booking_id).map((b) => b.group_booking_id),
  );

  box.innerHTML =
    '<div class="bk-preview-stat"><span>Arrivals</span><span>' +
    arrivals.length +
    " room" + (arrivals.length !== 1 ? "s" : "") +
    "</span></div>" +
    '<div class="bk-preview-stat"><span>Guests expected</span><span>' + guests + "</span></div>" +
    (groups.size
      ? '<div class="bk-preview-stat"><span>Multi-room groups</span><span>' + groups.size + "</span></div>"
      : "") +
    '<div class="bk-preview-stat"><span>Balance to collect</span><span>₹' + balance + "</span></div>";
}

function _bkSourceLabel(b) {
  if (isOtaPrepaid(b.booking_source)) return otaSourceLabel(b.booking_source);
  if (b.booking_source === "booking.com") return "Booking.com";
  return "Direct";
}

function _bkArrivalRowsHtml(arrivals, groupLabels) {
  return arrivals
    .map((b, i) => {
      const nights = _waNights(b.check_in_date, b.check_out_date);
      const isOta = isOtaPrepaid(b.booking_source);
      const bal = b.balance != null ? b.balance : (b.total_amount || 0) - (b.paid_amount || 0);
      const groupTag =
        b.group_booking_id && groupLabels.has(b.group_booking_id)
          ? '<span class="bk-group-tag">' + _bkEsc(groupLabels.get(b.group_booking_id)) + "</span>"
          : "";
      const checkOut = b.check_out_date
        ? new Date(b.check_out_date + "T00:00:00").toLocaleDateString("en-IN", {
            day: "2-digit", month: "short",
          })
        : "—";
      return (
        "<tr>" +
        '<td class="bk-c-idx">' + (i + 1) + "</td>" +
        '<td><div class="bk-c-room">' + _bkEsc(b.room) +
          (b.is_ac ? ' <span class="bk-ac">AC</span>' : "") + "</div>" +
          (groupTag ? '<div style="margin-top:0.8mm">' + groupTag + "</div>" : "") + "</td>" +
        '<td><div class="bk-c-name">' + _bkEsc(b.guest_name) + "</div>" +
          '<div class="bk-c-sub">' + _bkEsc(b.guest_mobile || "no contact on file") +
          ' &nbsp;<span class="bk-src">' + _bkEsc(_bkSourceLabel(b)) + "</span></div></td>" +
        '<td class="bk-c-mid">' + (b.guest_count || 1) + "</td>" +
        '<td class="bk-c-mid">' + _bkEsc(formatTime(b.check_in_time || "14:00")) + "</td>" +
        '<td class="bk-c-mid">' + _bkEsc(checkOut) +
          '<div class="bk-c-sub">' + nights + " night" + (nights !== 1 ? "s" : "") + "</div></td>" +
        '<td class="bk-c-num">' + (isOta ? "Prepaid" : "₹" + (b.total_amount || 0)) +
          '<div class="bk-c-sub bk-c-due">' +
          (isOta ? "settled via OTA" : "due ₹" + (bal > 0 ? bal : 0)) + "</div></td>" +
        "<td></td>" +
        '<td class="bk-c-tick"><span class="bk-tick-box"></span></td>' +
        '<td class="bk-c-tick"><span class="bk-tick-box"></span></td>' +
        '<td class="bk-c-tick"><span class="bk-tick-box"></span></td>' +
        '<td class="bk-c-tick"><span class="bk-tick-box"></span></td>' +
        "<td></td>" +
        "</tr>"
      );
    })
    .join("");
}

function buildArrivalsSheetHtml(dateStr, includeDepartures) {
  const arrivals = _bkArrivalsFor(dateStr);
  const departures = includeDepartures ? _bkDeparturesFor(dateStr) : [];

  // Label each multi-room group A, B, C… so rooms that travel together are
  // obvious on paper without printing raw UUIDs.
  const groupLabels = new Map();
  arrivals.forEach((b) => {
    if (!b.group_booking_id || groupLabels.has(b.group_booking_id)) return;
    if (arrivals.filter((x) => x.group_booking_id === b.group_booking_id).length > 1) {
      groupLabels.set(b.group_booking_id, "GRP " + String.fromCharCode(65 + groupLabels.size));
    }
  });

  const guests = arrivals.reduce((s, b) => s + (b.guest_count || 1), 0);
  const balance = arrivals.reduce(
    (s, b) =>
      s +
      (isOtaPrepaid(b.booking_source)
        ? 0
        : b.balance != null
          ? b.balance
          : (b.total_amount || 0) - (b.paid_amount || 0)),
    0,
  );

  const printedAt = new Date().toLocaleString("en-IN", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  // Percentage widths so the sheet fills whatever page size and margins the
  // printer is set to, instead of being tuned to one paper size in mm.
  const arrivalsTable = arrivals.length
    ? "<table><colgroup>" +
      ["3%","8%","19%","4%","7%","9%","11%","10%","5%","5%","4%","5%","10%"]
        .map((w) => '<col style="width:' + w + '"/>').join("") +
      "</colgroup><thead><tr>" +
      "<th>#</th>" +
      "<th>Room</th>" +
      "<th>Guest &amp; contact</th>" +
      "<th>Pax</th>" +
      "<th>ETA</th>" +
      "<th>Check-out</th>" +
      "<th style=\"text-align:right\">Amount</th>" +
      "<th>Room allotted</th>" +
      "<th class=\"bk-c-tick\">Ready</th>" +
      "<th class=\"bk-c-tick\">Insp.</th>" +
      "<th class=\"bk-c-tick\">ID</th>" +
      "<th class=\"bk-c-tick\">Keys</th>" +
      "<th>Remarks</th>" +
      "</tr></thead><tbody>" +
      _bkArrivalRowsHtml(arrivals, groupLabels) +
      "</tbody></table>"
    : '<div class="bk-sheet-empty">No arrivals booked for this date.</div>';

  const departuresTable = !includeDepartures
    ? ""
    : '<div class="bk-sheet-block">' +
      '<div class="bk-sheet-section"><span>Departures</span>' +
      '<span class="bk-section-note">Rooms expected to free up</span></div>' +
      (departures.length
        ? "<table><colgroup>" +
          ["7%","24%","11%","11%","7%","7%","7%","26%"]
            .map((w) => '<col style="width:' + w + '"/>').join("") +
          "</colgroup><thead><tr>" +
          "<th>Room</th><th>Guest</th><th>Checked in</th>" +
          "<th style=\"text-align:right\">Balance</th>" +
          "<th class=\"bk-c-tick\">Vacated</th>" +
          "<th class=\"bk-c-tick\">Cleaned</th>" +
          "<th class=\"bk-c-tick\">Insp.</th>" +
          "<th>Remarks</th>" +
          "</tr></thead><tbody>" +
          departures
            .map((b) => {
              const bal = b.balance != null ? b.balance : (b.total_amount || 0) - (b.paid_amount || 0);
              return (
                "<tr>" +
                '<td><div class="bk-c-room">' + _bkEsc(b.room) +
                  (b.is_ac ? ' <span class="bk-ac">AC</span>' : "") + "</div></td>" +
                '<td><div class="bk-c-name">' + _bkEsc(b.guest_name) + "</div>" +
                  '<div class="bk-c-sub">' + _bkEsc(b.guest_mobile || "—") + "</div></td>" +
                '<td class="bk-c-mid">' + _bkEsc(_bkShortDate(b.check_in_date)) + "</td>" +
                '<td class="bk-c-num">' +
                  (isOtaPrepaid(b.booking_source) ? "—" : "₹" + (bal > 0 ? bal : 0)) + "</td>" +
                '<td class="bk-c-tick"><span class="bk-tick-box"></span></td>' +
                '<td class="bk-c-tick"><span class="bk-tick-box"></span></td>' +
                '<td class="bk-c-tick"><span class="bk-tick-box"></span></td>' +
                "<td></td>" +
                "</tr>"
              );
            })
            .join("") +
          "</tbody></table>"
        : '<div class="bk-sheet-empty">No departures expected for this date.</div>') +
      "</div>";

  const groupNote = groupLabels.size
    ? groupLabels.size + " multi-room group" + (groupLabels.size !== 1 ? "s" : "") +
      " — rooms sharing a tag arrive together"
    : "One room per line";

  return (
    '<div class="bk-sheet">' +
      '<div class="bk-sheet-head">' +
        '<div><div class="bk-brand-name">CIBARA COMFORTS</div>' +
          '<div class="bk-brand-rule"></div></div>' +
        '<div class="bk-doc">' +
          '<div class="bk-doc-title">Arrivals &amp; Room Inspection</div>' +
          '<div class="bk-doc-date">' + _bkEsc(_bkLongDate(dateStr)) + "</div>" +
        "</div>" +
        '<div class="bk-doc-meta">' +
          '<div><span class="bk-k">Printed</span>' + _bkEsc(printedAt) + "</div>" +
          '<div><span class="bk-k">Duty manager</span>________________</div>' +
        "</div>" +
      "</div>" +

      '<div class="bk-stats">' +
        "<div class=\"bk-stat\"><span>Rooms arriving</span><b>" + arrivals.length + "</b></div>" +
        "<div class=\"bk-stat\"><span>Guests expected</span><b>" + guests + "</b></div>" +
        "<div class=\"bk-stat\"><span>Balance to collect</span><b>₹" + balance + "</b></div>" +
        (includeDepartures
          ? "<div class=\"bk-stat\"><span>Departures</span><b>" + departures.length + "</b></div>"
          : "") +
        "<div class=\"bk-stat\"><span>Multi-room groups</span><b>" + groupLabels.size + "</b></div>" +
      "</div>" +

      '<div class="bk-sheet-block">' +
        '<div class="bk-sheet-section"><span>Arrivals</span>' +
        '<span class="bk-section-note">' + _bkEsc(groupNote) + "</span></div>" +
        arrivalsTable +
      "</div>" +

      departuresTable +

      '<div class="bk-sign">' +
        '<div class="bk-sign-line">Prepared by</div>' +
        '<div class="bk-sign-line">Rooms inspected by</div>' +
        '<div class="bk-sign-line">Verified by / time</div>' +
      "</div>" +
      '<div class="bk-sheet-note">Insp. = room inspected and passed. ' +
        "Allotted room numbers are provisional until inspection is signed off.</div>" +
    "</div>"
  );
}

function printArrivalsSheet() {
  const root = document.getElementById("booking-print-root");
  if (!root) {
    showNotification("Print area missing — reload the page and try again", "error");
    return;
  }
  const dateStr = _bkArrivalsSelectedDate();
  const includeDepartures = !!document.getElementById("arrivals-include-departures")?.checked;

  // The print stylesheet hides every direct child of <body> except this node.
  // Re-parent it defensively so the rule holds even if the template moves it
  // inside a wrapper later — a nested print root would be hidden along with
  // its ancestor and the page would come out blank.
  if (root.parentElement !== document.body) document.body.appendChild(root);

  root.innerHTML = buildArrivalsSheetHtml(dateStr, includeDepartures);
  document.body.classList.add("bk-printing");

  // Only the body class is removed on the way out. The sheet markup is left
  // in place (the node is display:none on screen) and overwritten on the next
  // print: some browsers fire `afterprint` as soon as the preview opens
  // rather than when it closes, and clearing the node there empties the
  // preview the user is looking at.
  const cleanup = () => {
    document.body.classList.remove("bk-printing");
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  setTimeout(cleanup, 120000);

  // Two frames: one for the style/class change to apply, one for layout of
  // the freshly inserted table, before the dialog snapshots the page.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        window.print();
      } catch (e) {
        console.error("Arrivals sheet print failed:", e);
        showNotification("Could not open the print dialog", "error");
        cleanup();
      }
    });
  });
}

async function openArrivalsSheetModal() {
  const modal = document.getElementById("arrivals-sheet-modal");
  if (!modal) return;

  const dateInput = document.getElementById("arrivals-sheet-date");
  if (dateInput && !dateInput.value) dateInput.value = _bkYmd(new Date());

  modal.classList.add("show");
  // Always work from fresh data — the sheet is acted on physically, so a
  // stale cancellation on it would send someone to an occupied room.
  try {
    await fetchBookings();
  } catch (e) {
    console.error("Arrivals sheet: could not refresh bookings", e);
  }
  renderArrivalsSheetPreview();
}

function initArrivalsSheet() {
  const openBtn = document.getElementById("print-arrivals-btn");
  if (openBtn) openBtn.addEventListener("click", openArrivalsSheetModal);

  const dateInput = document.getElementById("arrivals-sheet-date");
  if (dateInput) dateInput.addEventListener("change", renderArrivalsSheetPreview);

  document.querySelectorAll("[data-arrivals-preset]").forEach((chip) => {
    chip.addEventListener("click", function () {
      const d = new Date();
      if (this.dataset.arrivalsPreset === "tomorrow") d.setDate(d.getDate() + 1);
      if (dateInput) dateInput.value = _bkYmd(d);
      renderArrivalsSheetPreview();
    });
  });

  const printBtn = document.getElementById("arrivals-sheet-print-btn");
  if (printBtn) printBtn.addEventListener("click", printArrivalsSheet);
}

document.addEventListener("DOMContentLoaded", initArrivalsSheet);

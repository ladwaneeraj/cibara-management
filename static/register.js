// Register Module - Production Ready
// ==========================================

// Configuration
const REGISTER_CONFIG = {
  defaultDaysToShow: 3,
  billNumberPrefix: "CC",
  gstRate: 0.05,
  gstThreshold: 999,
  dateFormat: "DD-MMM-YYYY",
  timeFormat: "hh:mm A",
};

// State Management
let registerState = {
  allEntries: [],
  filteredEntries: [],
  dateRange: {
    start: null,
    end: null,
  },
  filters: {
    search: "",
    payment: "all",
    status: "all",
  },
};

// DOM Elements Cache
const DOM = {
  startDate: null,
  endDate: null,
  searchInput: null,
  paymentFilter: null,
  statusFilter: null,
  tableBody: null,
  refreshBtn: null,
  exportBtn: null,
  billModal: null,
};

// Initialize Register Module
function initializeRegister() {
  cacheDOMElements();
  setDefaultDateRange();
  attachEventListeners();
  loadRegisterData();
}

// Cache DOM elements
function cacheDOMElements() {
  DOM.startDate = document.getElementById("start-date");
  DOM.endDate = document.getElementById("end-date");
  DOM.searchInput = document.getElementById("search-register");
  DOM.paymentFilter = document.getElementById("payment-filter");
  DOM.statusFilter = document.getElementById("status-filter");
  DOM.tableBody = document.getElementById("register-table-body");
  DOM.refreshBtn = document.getElementById("refresh-register-btn");
  DOM.exportBtn = document.getElementById("export-excel-btn");
  DOM.billModal = document.getElementById("bill-modal");
}

// Set default date range (last 3 days) - BUT allow user to go back further
function setDefaultDateRange() {
  const today = new Date();
  const threeDaysAgo = new Date(today);
  threeDaysAgo.setDate(
    today.getDate() - (REGISTER_CONFIG.defaultDaysToShow - 1),
  );

  DOM.startDate.value = formatDateForInput(threeDaysAgo);
  DOM.endDate.value = formatDateForInput(today);

  // Set min date to allow going back 1 year
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(today.getFullYear() - 1);
  DOM.startDate.min = formatDateForInput(oneYearAgo);

  registerState.dateRange.start = threeDaysAgo;
  registerState.dateRange.end = today;
}

// Attach event listeners
function attachEventListeners() {
  DOM.startDate.addEventListener("change", handleDateChange);
  DOM.endDate.addEventListener("change", handleDateChange);
  DOM.searchInput.addEventListener("input", debounce(handleSearch, 300));
  DOM.paymentFilter.addEventListener("change", handleFilterChange);
  DOM.statusFilter.addEventListener("change", handleFilterChange);
  DOM.refreshBtn.addEventListener("click", loadRegisterData);
  DOM.exportBtn.addEventListener("click", exportToExcel);

  document.addEventListener("click", (e) => {
    if (
      e.target.classList.contains("bill-close") ||
      e.target.id === "bill-modal"
    ) {
      closeBillModal();
    }
  });
}

// Event Handlers
function handleDateChange() {
  registerState.dateRange.start = new Date(DOM.startDate.value);
  registerState.dateRange.end = new Date(DOM.endDate.value);
  loadRegisterData();
}

function handleSearch() {
  registerState.filters.search = DOM.searchInput.value.toLowerCase();
  applyFilters();
}

function handleFilterChange() {
  registerState.filters.payment = DOM.paymentFilter.value;
  registerState.filters.status = DOM.statusFilter.value;
  applyFilters();
}

// Data Loading
async function loadRegisterData() {
  showLoading();

  try {
    const response = await fetch("/get_register_data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start_date: formatDateForAPI(registerState.dateRange.start),
        end_date: formatDateForAPI(registerState.dateRange.end),
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to fetch register data");
    }

    const data = await response.json();

    if (data.success) {
      registerState.allEntries = data.entries || [];
      applyFilters();
    } else {
      showError(data.message || "Failed to load data");
    }
  } catch (error) {
    console.error("Error loading register:", error);
    showError("Error loading register data");
  }
}

// Filtering Logic
function applyFilters() {
  let filtered = [...registerState.allEntries];

  // Search filter
  if (registerState.filters.search) {
    filtered = filtered.filter(
      (entry) =>
        entry.guest_name.toLowerCase().includes(registerState.filters.search) ||
        entry.guest_mobile.includes(registerState.filters.search) ||
        entry.room.toString().includes(registerState.filters.search) ||
        entry.bill_number.toLowerCase().includes(registerState.filters.search),
    );
  }

  // Payment filter
  if (registerState.filters.payment !== "all") {
    filtered = filtered.filter((entry) => {
      switch (registerState.filters.payment) {
        case "cash":
          return entry.payment_cash > 0 && entry.payment_online === 0;
        case "online":
          return entry.payment_online > 0 && entry.payment_cash === 0;
        case "split":
          return entry.payment_cash > 0 && entry.payment_online > 0;
        case "pending":
          return entry.balance > 0;
        default:
          return true;
      }
    });
  }

  // Status filter
  if (registerState.filters.status !== "all") {
    filtered = filtered.filter(
      (entry) => entry.status === registerState.filters.status,
    );
  }

  registerState.filteredEntries = filtered;
  renderRegisterTable();
}

// Rendering
function renderRegisterTable() {
  if (registerState.filteredEntries.length === 0) {
    showEmptyState();
    return;
  }

  const groupedByDate = groupEntriesByDate(registerState.filteredEntries);

  let html = "";

  Object.keys(groupedByDate)
    .sort((a, b) => new Date(b) - new Date(a))
    .forEach((date) => {
      const entries = groupedByDate[date];
      const formattedDate = formatDisplayDate(new Date(date));

      html += `
            <tr class="date-group-header" onclick="toggleDateGroup('${date}')">
                <td colspan="14">
                    <i class="fas fa-chevron-down"></i>
                    ${formattedDate} (${entries.length} entries)
                </td>
            </tr>
        `;

      // Use entry's own serial number (already assigned in backend)
      entries.forEach((entry) => {
        html += renderRegisterRow(entry, entry.serial_number || 0, date);
      });
    });

  DOM.tableBody.innerHTML = html;
}

function renderRegisterRow(entry, serial, dateGroup) {
  const days =
    entry.days_stayed || calculateDays(entry.checkin_time, entry.checkout_time);
  const statusClass =
    entry.status === "active" ? "status-active" : "status-completed";

  // Use entry's own serial_number if available, otherwise use passed serial
  const displaySerial = entry.serial_number || serial;

  // Bill button - ONLY for completed
  const billButton =
    entry.status === "completed"
      ? `<button class="bill-btn" onclick="viewBill('${entry.id}')">
               <i class="fas fa-file-invoice"></i> Bill
           </button>`
      : `<span style="color: #999;">-</span>`;

  // Bill number
  const billNo = entry.status === "completed" ? entry.bill_number : "-";

  return `
        <tr class="date-group-row" data-date-group="${dateGroup}">
            <td>${displaySerial}</td>
            <td>${billNo}</td>
            <td>${entry.guest_name}</td>
            <td>${entry.guest_mobile}</td>
            <td>${entry.room}</td>
            <td>${formatDateTime(entry.checkin_time)}</td>
            <td>${entry.checkout_time ? formatDateTime(entry.checkout_time) : "-"}</td>
            <td>${days}</td>
            <td>₹${(entry.room_rent || 0).toFixed(2)}</td>
            <td>₹${(entry.services_total || 0).toFixed(2)}</td>
            <td>₹${entry.total_amount.toFixed(2)}</td>
            <td>${renderPaymentSplit(entry)}</td>
            <td><span class="status-badge ${statusClass}">${entry.status}</span></td>
            <td>${billButton}</td>
        </tr>
    `;
}

function renderPaymentSplit(entry) {
  let html = '<div class="payment-split">';

  if (entry.payment_cash > 0) {
    html += `
            <div class="payment-item">
                <span class="payment-method cash">Cash</span>
                <span>₹${entry.payment_cash.toFixed(2)}</span>
            </div>
        `;
  }

  if (entry.payment_online > 0) {
    html += `
            <div class="payment-item">
                <span class="payment-method online">Online</span>
                <span>₹${entry.payment_online.toFixed(2)}</span>
            </div>
        `;
  }

  if (entry.balance > 0) {
    html += `
            <div class="payment-item">
                <span class="payment-method balance">Balance</span>
                <span>₹${entry.balance.toFixed(2)}</span>
            </div>
        `;
  }

  if (
    entry.payment_cash === 0 &&
    entry.payment_online === 0 &&
    entry.balance === 0
  ) {
    html += '<span style="color: #999;">-</span>';
  }

  html += "</div>";
  return html;
}

// Bill Generation
async function viewBill(entryId) {
  try {
    const response = await fetch(`/generate_bill/${entryId}`);

    if (!response.ok) {
      throw new Error("Failed to generate bill");
    }

    const data = await response.json();

    if (data.success) {
      displayBill(data.bill);
    } else {
      showError(data.message || "Failed to generate bill");
    }
  } catch (error) {
    console.error("Error generating bill:", error);
    showError("Error generating bill");
  }
}

function displayBill(billData) {
  const billHTML = generateBillHTML(billData);
  document.getElementById("bill-print-area").innerHTML = billHTML;
  DOM.billModal.classList.add("show");

  // Attach print handler
  const printBtn = document.getElementById("print-bill-btn");
  if (printBtn) {
    printBtn.onclick = function () {
      // Hide everything except bill
      document.body.classList.add("printing");
      setTimeout(() => {
        window.print();
        document.body.classList.remove("printing");
      }, 100);
    };
  }
}

function generateBillHTML(billData) {
  const checkinDate = new Date(billData.checkin_time);
  const checkoutDate = billData.checkout_time
    ? new Date(billData.checkout_time)
    : new Date();

  const days =
    billData.days_stayed ||
    calculateDays(billData.checkin_time, billData.checkout_time);
  const dailyRate = billData.room_rent || billData.room_price_per_night || 0;
  const totalRoomCharges = dailyRate * days;

  // ===================================
  // GST CALCULATION (INCLUSIVE) - Split into CGST and SGST
  // ===================================
  let baseRoomAmount = 0;
  let cgstAmount = 0;
  let sgstAmount = 0;
  let totalGST = 0;

  if (dailyRate > 999) {
    // GST applicable: Total includes GST
    // Formula: Base = Total / 1.05
    baseRoomAmount = totalRoomCharges / 1.05;
    totalGST = totalRoomCharges - baseRoomAmount;
    cgstAmount = totalGST / 2; // 2.5%
    sgstAmount = totalGST / 2; // 2.5%
  } else {
    // No GST
    baseRoomAmount = totalRoomCharges;
    cgstAmount = 0;
    sgstAmount = 0;
    totalGST = 0;
  }

  const servicesTotal = billData.services_total || 0;
  const discounts = billData.discounts || 0;
  const grandTotal = totalRoomCharges + servicesTotal - discounts;

  // Payment details
  const cashPaid = billData.payment_cash || 0;
  const onlinePaid = billData.payment_online || 0;
  const totalPaid = cashPaid + onlinePaid;
  const balance = billData.balance || 0;

  // Services rows
  let servicesRows = "";
  if (billData.services && billData.services.length > 0) {
    servicesRows = billData.services
      .map(
        (service) => `
            <tr>
                <td>${service.item}</td>
                <td class="text-right">${service.quantity || 1}</td>
                <td class="text-right">₹${(service.unit_price || service.price || 0).toFixed(2)}</td>
                <td class="text-right">₹${(service.price || 0).toFixed(2)}</td>
            </tr>
        `,
      )
      .join("");
  } else if (servicesTotal > 0) {
    servicesRows = `
            <tr>
                <td>Services</td>
                <td class="text-right">-</td>
                <td class="text-right">-</td>
                <td class="text-right">₹${servicesTotal.toFixed(2)}</td>
            </tr>
        `;
  }

  return `
        <div class="bill-lodge-header">
            <div class="bill-lodge-name">CIBARA COMFORTS</div>
            <div class="bill-lodge-address">Near Bus Stand, Harihar, Karnataka - 577601</div>
            <div class="bill-lodge-contact">Phone: +91 9876543210 | GSTIN: 29XXXXX1234X1ZX</div>
            <h2 style="margin-top: 15px; text-align: center;">TAX INVOICE</h2>
        </div>
        
        <div class="bill-info-section">
            <div>
                <div class="bill-info-row">
                    <span class="bill-label">Bill No:</span>
                    <span>${billData.bill_number || "N/A"}</span>
                </div>
                <div class="bill-info-row">
                    <span class="bill-label">Guest Name:</span>
                    <span>${billData.guest_name}</span>
                </div>
                <div class="bill-info-row">
                    <span class="bill-label">Mobile:</span>
                    <span>${billData.guest_mobile || "N/A"}</span>
                </div>
                <div class="bill-info-row">
                    <span class="bill-label">Room No:</span>
                    <span>${billData.room}</span>
                </div>
            </div>
            <div>
                <div class="bill-info-row">
                    <span class="bill-label">Check-in:</span>
                    <span>${formatDateTime(billData.checkin_time)}</span>
                </div>
                <div class="bill-info-row">
                    <span class="bill-label">Check-out:</span>
                    <span>${billData.checkout_time ? formatDateTime(billData.checkout_time) : "Active"}</span>
                </div>
                <div class="bill-info-row">
                    <span class="bill-label">Days Stayed:</span>
                    <span>${days}</span>
                </div>
                <div class="bill-info-row">
                    <span class="bill-label">Bill Date:</span>
                    <span>${formatDateTime(billData.checkout_time || new Date().toISOString())}</span>
                </div>
            </div>
        </div>
        
        <table class="bill-charges-table">
            <thead>
                <tr>
                    <th>Description</th>
                    <th class="text-right">Qty</th>
                    <th class="text-right">Rate</th>
                    <th class="text-right">Amount</th>
                </tr>
            </thead>
            <tbody>
                <tr class="bill-section-header">
                    <td colspan="4">Room Charges</td>
                </tr>
                <tr>
                    <td>Room Rent (Base Amount)</td>
                    <td class="text-right">${days}</td>
                    <td class="text-right">₹${dailyRate.toFixed(2)}</td>
                    <td class="text-right">₹${baseRoomAmount.toFixed(2)}</td>
                </tr>
                <tr>
                    <td style="padding-left: 20px;">CGST @ 2.5%</td>
                    <td class="text-right">-</td>
                    <td class="text-right">-</td>
                    <td class="text-right">₹${cgstAmount.toFixed(2)}</td>
                </tr>
                <tr>
                    <td style="padding-left: 20px;">SGST @ 2.5%</td>
                    <td class="text-right">-</td>
                    <td class="text-right">-</td>
                    <td class="text-right">₹${sgstAmount.toFixed(2)}</td>
                </tr>
                <tr style="font-weight: 600;">
                    <td colspan="3" class="text-right">Total Room Charges:</td>
                    <td class="text-right">₹${totalRoomCharges.toFixed(2)}</td>
                </tr>
                
                ${
                  servicesRows
                    ? `
                <tr class="bill-section-header">
                    <td colspan="4">Additional Services</td>
                </tr>
                ${servicesRows}
                <tr style="font-weight: 600;">
                    <td colspan="3" class="text-right">Total Services:</td>
                    <td class="text-right">₹${servicesTotal.toFixed(2)}</td>
                </tr>
                `
                    : ""
                }
                
                ${
                  discounts > 0
                    ? `
                <tr class="bill-section-header">
                    <td colspan="4">Discounts</td>
                </tr>
                <tr>
                    <td>Discount Applied</td>
                    <td class="text-right">-</td>
                    <td class="text-right">-</td>
                    <td class="text-right" style="color: var(--success);">-₹${discounts.toFixed(2)}</td>
                </tr>
                `
                    : ""
                }
                
                <tr class="bill-total-row">
                    <td colspan="3" class="text-right"><strong>GRAND TOTAL:</strong></td>
                    <td class="text-right"><strong>₹${grandTotal.toFixed(2)}</strong></td>
                </tr>
            </tbody>
        </table>
        
        <div class="bill-payment-section">
            <h3 style="margin-bottom: 10px;">Payment Details</h3>
            <table class="bill-charges-table">
                <tbody>
                    <tr>
                        <td>Cash Payment</td>
                        <td class="text-right">₹${cashPaid.toFixed(2)}</td>
                    </tr>
                    <tr>
                        <td>Online Payment</td>
                        <td class="text-right">₹${onlinePaid.toFixed(2)}</td>
                    </tr>
                    <tr style="font-weight: 600;">
                        <td>Total Paid</td>
                        <td class="text-right">₹${totalPaid.toFixed(2)}</td>
                    </tr>
                    <tr style="font-weight: bold; font-size: 1.1rem; ${balance > 0 ? "color: var(--danger)" : "color: var(--success)"}">
                        <td>${balance > 0 ? "Balance Due" : balance < 0 ? "Refund Due" : "Fully Paid"}</td>
                        <td class="text-right">₹${Math.abs(balance).toFixed(2)}</td>
                    </tr>
                </tbody>
            </table>
        </div>
        
        <div class="bill-signature">
            <div class="signature-block">
                <div class="signature-line">Guest Signature</div>
            </div>
            <div class="signature-block">
                <div class="signature-line">Authorized Signatory</div>
            </div>
        </div>
        
        <div class="bill-footer">
            <p>Thank you for staying with us!</p>
            <p style="font-size: 0.7rem; margin-top: 5px;">This is a computer-generated invoice and does not require a physical signature.</p>
        </div>
    `;
}

function printBill() {
  // Small delay to ensure modal is fully rendered
  setTimeout(() => {
    window.print();
  }, 100);
}

function closeBillModal() {
  DOM.billModal.classList.remove("show");
}

// Export to Excel - FIXED
function exportToExcel() {
  if (registerState.filteredEntries.length === 0) {
    alert("No data available to export");
    return;
  }

  // Prepare data
  const exportData = registerState.filteredEntries.map((entry, index) => ({
    "Sr. No": index + 1,
    "Bill No": entry.bill_number,
    "Guest Name": entry.guest_name,
    Contact: entry.guest_mobile,
    Room: entry.room,
    "Check-in": formatDateTime(entry.checkin_time),
    "Check-out": entry.checkout_time
      ? formatDateTime(entry.checkout_time)
      : "-",
    Days:
      entry.days_stayed ||
      calculateDays(entry.checkin_time, entry.checkout_time),
    "Room Charges": entry.room_charges,
    Services: entry.services_total || 0,
    Total: entry.total_amount,
    Cash: entry.payment_cash,
    Online: entry.payment_online,
    Balance: entry.balance,
    Status: entry.status,
  }));

  // Create worksheet
  const ws = XLSX.utils.json_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Register");

  // Generate filename
  const filename = `Register_${formatDateForAPI(registerState.dateRange.start)}_to_${formatDateForAPI(registerState.dateRange.end)}.xlsx`;

  // Save file
  XLSX.writeFile(wb, filename);
}

// Utility Functions
function groupEntriesByDate(entries) {
  return entries.reduce((groups, entry) => {
    const date = entry.checkin_time.split(" ")[0];
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(entry);
    return groups;
  }, {});
}

function toggleDateGroup(date) {
  const header = event.currentTarget;
  const rows = document.querySelectorAll(
    `tr.date-group-row[data-date-group="${date}"]`,
  );
  const icon = header.querySelector("i");

  header.classList.toggle("collapsed");
  rows.forEach((row) => row.classList.toggle("hidden"));
}

function calculateDays(checkin, checkout) {
  if (!checkout) return "-";

  const checkinDate = new Date(checkin);
  const checkoutDate = new Date(checkout);
  const diffTime = Math.abs(checkoutDate - checkinDate);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  return diffDays || 1;
}

function formatDateForInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateForAPI(date) {
  return formatDateForInput(date);
}

function formatDisplayDate(date) {
  const options = { day: "2-digit", month: "short", year: "numeric" };
  return date.toLocaleDateString("en-IN", options);
}

function formatDateTime(dateTimeStr) {
  if (!dateTimeStr) return "-";

  const [datePart, timePart] = dateTimeStr.split(" ");
  const [year, month, day] = datePart.split("-");
  const date = new Date(year, month - 1, day);

  const dateFormatted = formatDisplayDate(date);
  return `${dateFormatted} ${timePart || ""}`.trim();
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function showLoading() {
  DOM.tableBody.innerHTML = `
        <tr>
            <td colspan="14">
                <div class="loading-indicator">
                    <div class="loader"></div>
                    <p>Loading register data...</p>
                </div>
            </td>
        </tr>
    `;
}

function showEmptyState() {
  DOM.tableBody.innerHTML = `
        <tr>
            <td colspan="14">
                <div class="empty-state">
                    <i class="fas fa-inbox"></i>
                    <p>No entries found for the selected period</p>
                </div>
            </td>
        </tr>
    `;
}

function showError(message) {
  DOM.tableBody.innerHTML = `
        <tr>
            <td colspan="14">
                <div class="empty-state" style="color: var(--danger);">
                    <i class="fas fa-exclamation-circle"></i>
                    <p>${message}</p>
                </div>
            </td>
        </tr>
    `;
}

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("register-table-body")) {
    initializeRegister();
  }
});

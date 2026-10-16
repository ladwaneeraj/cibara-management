// ESLint flat config — classic-UI vanilla JS only (static/).
//
// WHY THIS EXISTS
// The classic screens are plain <script> files concatenated into one browser
// global scope; there is no bundler and no type checker to catch a reference
// to a name that was never defined (a mistyped helper, a function used before
// its file loads). `no-undef` is the guard for exactly that class of bug — the
// kind that shipped as real init failures in this codebase.
//
// Because every static/*.js shares one global scope, helpers that one file
// defines and another calls are legitimate cross-file globals. They are
// declared below (CIBARA_GLOBALS) so `no-undef` flags only genuinely unknown
// names. Keep this list in sync when a new `window.Foo = ...` export is added.
//
// The React SPA in frontend/ has its own ESLint config and `tsc` strict mode;
// it is intentionally excluded here.

import js from '@eslint/js';
import globals from 'globals';

// Helpers the classic UI assigns to `window` (or defines at top level) in one
// file and references from another. Sourced from `window.<name> =` exports
// across static/*.js. Writable because a few are reassigned.
const CIBARA_GLOBALS = [
  'CIBARA_OPTIMISTIC', 'CibaraAdmin', 'CibaraAttribution', 'CibaraAuth',
  'CibaraBillCancel', 'CibaraBills', 'CibaraDocAddHandler', 'CibaraDocScan',
  'CibaraInvoiceSettings', 'CibaraModalBack', 'CibaraRateChange',
  'CibaraRegister', 'CibaraRoomAttribution', 'CibaraSecureImg', 'CibaraSelect',
  'CibaraState', 'CibaraUsers', 'FIREBASE_CONFIG', 'MAX_DOC_PHOTOS',
  'RoomCalendar', 'RoomPhotos', '__forceFresh', '__initialUIConfig',
  '__renewalTickerInstalled', '_blAddBillRes', '_cibaraBillsAutoGenerate',
  '_cibaraBillsGeneratePDF', '_getPaymentLogsPromise', '_notify',
  '_rpCancelEdit', '_rpDelete', '_rpStartEdit', '_rpmSave', '_svcCancelEdit',
  '_svcSave', '_svcSaveActive', '_svcSizeChanged', '_svcStartEdit', '_svcVoid',
  '_txnMgrExpPicker', '_txnPicker', '_txnReapplySearch', 'apiFetch',
  'applyReportFilters', 'bookingDatePicker', 'cibaraSaveAndShareBill',
  'cibaraWrites', 'closeAddCustomerForm', 'closeCustomerDetail',
  'closeCustomerManager', 'closeRevertConfirmModal', 'cmAddHandlePhotos',
  'cmAddRemovePhoto', 'cmClearSearch', 'cmCloseFlagModal', 'cmDeleteDoc',
  'cmHandlePhotoFiles', 'cmLoadMore', 'cmOpenFlagModal', 'cmRemovePending',
  'cmSaveCustomer', 'cmSearch', 'cmSetFilter', 'cmSubmitFlag',
  'cmSubmitNewCustomer', 'cmToggleEdit', 'cmToggleHistory',
  'cmUploadPendingPhotos', 'exportToExcel', 'fetchData', 'generateReport',
  'getCheckinGstProfile', 'getTransactionsViewDate', 'goToTransactionDate',
  'handleRevertCheckoutClick', 'initCheckoutDocAttach',
  'invalidateExpensePresetsCache', 'invalidateExpenseStaffCache',
  'invalidatePayHistoryCache', 'laundryCancelEdit', 'laundryDeleteAdjustment',
  'laundryDeleteBill', 'laundryDeletePayment', 'laundryEditBill',
  'laundryEditRow', 'laundryOpenCorrections', 'laundryReceiveRow',
  'laundrySaveRow', 'laundryToggleDateLock', 'laundryUpdateRow', 'newOpId',
  'openAddCustomerForm', 'openCheckinTimeEditor', 'openCustomerDetail',
  'openCustomerManager', 'openDailyInsights', 'openExpenseEditModal',
  'openExpensePresetManager', 'openLaundryModal', 'openMaintenanceModal',
  'openManualBill', 'openPhotoViewer', 'openRegBill',
  'openRegisterPaymentsModal', 'openSettingsModal', 'openStaffLedger',
  'openStaffModal', 'openStaffQuickPay', 'optimisticWrite', 'payHistoryInsert',
  'populateCheckoutDocView', 'prefetchPayHistory', 'prefetchPaymentLogs',
  'rawReportData', 'reconcileTransactionsView', 'refreshReportsView',
  'refreshRoomsData', 'refreshStaffModule', 'refreshTransactionsView',
  'releaseExpenseDateLock', 'reloadRegister', 'renderEnhancedLogs',
  'renderLogs', 'renderRooms', 'reportData', 'rooms', 'saveCheckoutMobile',
  'saveGuestMobile', 'setupCheckoutConfirmation', 'showCheckinModal',
  'showCollectSettlementModal', 'showNotification', 'showToast',
  'startEditCheckoutMobile', 'startEditGuestMobile', 'startEditRoomPrice',
  'submitRevertCheckout', 'toggleSection', 'totals', 'transactionTracker',
  'txnInsertExpenseRow', 'txnMarkListSynced', 'txnRemoveExpenseRow',
  'upcomingBookings', 'updateCheckoutModal', 'updateDatePicker',
  'updatePaymentLogs', 'updateStats', 'uploadPendingDocIfAny',
  // Cross-file helpers/state defined at top level (not via window.*) in one
  // static/*.js and read from another; all confirmed defined in the tree.
  'logs', 'debouncedFetchData', 'mediaStream', 'roomPricing',
  'capturedPhotoData', 'uploadedPhotoUrl', 'transactionLog', 'debugLog',
  'txnActiveDateRange', 'markRoomAsCleaned', 'checkoutInProgress',
  'pendingBalance', 'attachMultiBookingMobileLookup', 'uploadPhoto',
  'cashTotal', 'onlineTotal', 'refundTotal', 'totalRevenue',
  'openMgrAccessModal', 'showBookingDetails', 'showCheckoutModal',
  'generateEnhancedReport', 'transactionLogManager', '_compressImage',
  '_rmPrepEvent', '_rmName', 'RM_CLEAN_ACTION', 'RM_INSPECT_ACTION',
  'fetchBookings', 'showNewBookingModalForDate', '_uiConfigState',
  'completeRoomCleaning', 'getCleaningTime', 'isRevertEligible',
  'formatRevertTimeLeft', 'initializeCleaningFeature',
  // Optional "call it if that module loaded" hooks, always referenced behind a
  // `typeof X === "function"` guard. Declared so no-undef flags only genuinely
  // unknown names, not these intentional soft dependencies.
  'loadInitialData', 'loadAllData', 'refreshRooms', 'initBookings',
  'initSettingsModal', 'initMgrAccessModal',
];

const cibaraGlobals = Object.fromEntries(CIBARA_GLOBALS.map((n) => [n, 'writable']));

// Third-party libraries loaded via <script> tags in templates/ (CDN globals),
// plus the UMD export guard a couple of files use (`typeof module !== ...`).
const vendorGlobals = {
  firebase: 'readonly', // firebase-*-compat (gstatic)
  Chart: 'readonly', // chart.js
  L: 'readonly', // leaflet + leaflet-heat
  flatpickr: 'readonly', // date pickers
  cv: 'readonly', // OpenCV.js (document auto-scan)
  XLSX: 'readonly', // SheetJS (Excel export)
  module: 'readonly', // UMD export guard
  exports: 'writable', // UMD export guard
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      'frontend/**',
      'guest/**',
      'backend/**',
      'tests/**',
      'migrations/**',
      'scripts/**',
      'uploads/**',
      'data/**',
      'static/firebase-config.js', // injected from env at runtime; not in git
    ],
  },
  js.configs.recommended,
  {
    // The service worker runs in its own global scope.
    files: ['static/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.serviceworker, ...globals.browser },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['static/**/*.js'],
    ignores: ['static/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...vendorGlobals,
        ...cibaraGlobals,
      },
    },
    rules: {
      // The headline guard: catch references to names that were never defined
      // (typos, removed helpers, load-order mistakes) — the init-bug class.
      'no-undef': 'error',
      // Each static/*.js is a separate ESLint scope, but at runtime they share
      // one global object; a helper declared `var`/`function` in its home file
      // and also listed as a global here is not a real redeclaration, so config
      // globals are excluded. Two pre-existing genuine in-file duplicates remain
      // (booking.js optimizeCalendarForScreenSize, script.js showCheckinModal);
      // they are behavioural and owner-reviewed, so this is a warning for now
      // rather than a merge blocker on the gate PR.
      'no-redeclare': ['warn', { builtinGlobals: false }],
      // Cosmetic or intentional-in-legacy patterns: keep as signal, not a
      // merge blocker, so the gate stays about correctness. CI fails on errors
      // and tolerates warnings.
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-func-assign': 'warn', // legacy reassigns a few hoisted fns to expose them
      'no-useless-escape': 'warn',
      'no-irregular-whitespace': 'warn',
      'no-prototype-builtins': 'warn',
      'no-cond-assign': ['error', 'except-parens'],
    },
  },
];

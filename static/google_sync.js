import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAj_K8Bq8IA0mYH94pu03s3DeDxc2pyCF4",
  authDomain: "cibara-software-61512.firebaseapp.com",
  projectId: "cibara-software-61512",
  storageBucket: "cibara-software-61512.firebasestorage.app",
  messagingSenderId: "117552649945",
  appId: "1:117552649945:web:5d4983739b1a8c077e50c8",
  measurementId: "G-5VY26JYPN0",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ─── Rooms listener ────────────────────────────────────────────────────────
// Skip the first snapshot (page already loaded via fetchData on startup).
// For subsequent snapshots, patch only the changed docs into the global
// `rooms` object and re-render — no full round-trip to Flask needed.
let roomsInitialLoad = true;

onSnapshot(collection(db, "rooms"), (snapshot) => {
  if (roomsInitialLoad) {
    roomsInitialLoad = false;
    return;
  }

  // Only react to changes that originated from another device/tab.
  // hasPendingWrites == true  →  this browser made the change (already patched locally).
  // fromCache == true         →  SDK restoring from offline cache, skip.
  if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) {
    return;
  }

  let changed = false;

  snapshot.docChanges().forEach((change) => {
    const roomId = change.doc.id; // e.g. "101"

    if (change.type === "removed") {
      // Room document deleted — clear it from local state
      if (typeof rooms !== "undefined" && rooms[roomId]) {
        delete rooms[roomId];
        changed = true;
      }
      return;
    }

    // "added" or "modified" — patch the room in-place
    if (typeof rooms !== "undefined") {
      rooms[roomId] = { ...rooms[roomId], ...change.doc.data() };
      changed = true;
    }
  });

  if (changed) {
    console.log("⚡ Remote room update — patching local state");
    if (typeof renderRooms === "function") renderRooms();
    // Notify Register & Bills modules so they re-fetch their data too.
    // This covers changes made on ANY device, not just the current browser.
    window.dispatchEvent(new CustomEvent("cibaraRoomUpdate", { detail: { type: "remote_sync" } }));
    showSyncToast();
  }
});

// ─── Totals listener ───────────────────────────────────────────────────────
// Keeps the dashboard stats bar in sync without a full fetchData() call.
let totalsInitialLoad = true;

onSnapshot(doc(db, "totals", "current_totals"), (snap) => {
  if (totalsInitialLoad) {
    totalsInitialLoad = false;
    return;
  }

  if (!snap.exists() || snap.metadata.fromCache) return;

  if (typeof totals !== "undefined" && snap.data()) {
    Object.assign(totals, snap.data());
    if (typeof updateStats === "function") updateStats();
    console.log("⚡ Remote totals update — stats refreshed");
  }
});

// ─── Toast helper ──────────────────────────────────────────────────────────
function showSyncToast() {
  const toast = document.createElement("div");
  toast.innerHTML = "☁️ Data Updated Automatically";
  toast.style.cssText = `
    position: fixed; bottom: 20px; right: 20px;
    background: #34495e; color: white; padding: 12px 24px;
    border-radius: 8px; font-size: 13px; z-index: 9999;
    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
    transition: opacity 0.5s;
  `;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 500);
  }, 2500);
}

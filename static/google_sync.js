import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import {
  getFirestore,
  collection,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";

// PASTE YOUR CONFIG FROM STEP 1 HERE
const firebaseConfig = {
  apiKey: "AIzaSyAj_K8Bq8IA0mYH94pu03s3DeDxc2pyCF4",
  authDomain: "cibara-software-61512.firebaseapp.com",
  projectId: "cibara-software-61512",
  storageBucket: "cibara-software-61512.firebasestorage.app",
  messagingSenderId: "117552649945",
  appId: "1:117552649945:web:5d4983739b1a8c077e50c8",
  measurementId: "G-5VY26JYPN0",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Logic to listen for changes
let isInitialLoad = true;

// This "listens" to the rooms collection in real-time
onSnapshot(collection(db, "rooms"), (snapshot) => {
  // We ignore the first trigger when the page loads
  if (isInitialLoad) {
    isInitialLoad = false;
    return;
  }

  // Check if the change happened on another device
  // hasPendingWrites is true if the change started in THIS browser
  const isLocalChange = snapshot.metadata.hasPendingWrites;

  if (!isLocalChange) {
    console.log("⚡ Change detected on another device! Syncing...");

    // This calls the function in your main index script
    // that fetches fresh data from Flask
    if (typeof fetchData === "function") {
      fetchData();
      showSyncToast();
    }
  }
});

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

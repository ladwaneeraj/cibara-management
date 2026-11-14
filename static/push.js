// FCM web push for owner booking alerts.
//
// Registers the messaging service worker, asks for notification permission,
// gets this device's FCM token and sends it to the server (/register_push_token)
// so razorpay_webhook can push "New booking" to the phone even when the ERP is
// fully closed. Disabled (no-op) until window.FIREBASE_CONFIG.vapidKey is set
// from the FCM_VAPID_KEY env var. Loaded after firebase-config.js.
import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging.js";

async function initPush() {
  const cfg = window.FIREBASE_CONFIG || {};
  if (!cfg.vapidKey) return;                       // push not configured yet
  if (!("serviceWorker" in navigator) || !("Notification" in window)) return;
  if (!window.PushManager) return;                 // unsupported browser
  try {
    const app = getApps().length ? getApp() : initializeApp(cfg);
    const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;
    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey: cfg.vapidKey, serviceWorkerRegistration: reg });
    if (!token) return;
    const post = window.apiFetch
      || ((url, opts) => fetch(url, { ...opts, credentials: "include" }));
    await post("/register_push_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    // Foreground: a native OS popup is suppressed while the tab is focused, so
    // surface the booking as an in-app toast instead.
    onMessage(messaging, (payload) => {
      const n = (payload && payload.notification) || {};
      if (typeof window.showNotification === "function") {
        window.showNotification((n.title || "New booking") + " — " + (n.body || ""), "success");
      }
    });
  } catch (_) {
    /* push is best-effort; a failure must never break the page */
  }
}

// Run once the page and firebase-config.js are ready.
if (document.readyState === "complete") initPush();
else window.addEventListener("load", initPush);

// ═══════════════════════════════════════════════════════
//  VoiceConnect — Service Worker v2.0
//  Background push notifications + call handling
// ═══════════════════════════════════════════════════════

const CACHE_NAME = "vc-cache-v2";
const PRECACHE = ["/", "/index.html"];

// ── INSTALL ──────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

// ── ACTIVATE ─────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

// ── FETCH (network-first, cache fallback) ─────────────
self.addEventListener("fetch", (event) => {
  // Only GET requests cache karo
  if (event.request.method !== "GET") return;
  // Socket.io aur API skip karo
  if (event.request.url.includes("/socket.io") || event.request.url.includes("/api/")) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── PUSH NOTIFICATION ─────────────────────────────────
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch (e) { data = { title: "VoiceConnect", body: event.data?.text() || "Notification" }; }

  const title  = data.title  || "📞 VoiceConnect";
  const body   = data.body   || "Incoming call";
  const caller = data.caller || "";
  const url    = data.url    || "/";

  const options = {
    body,
    icon:             "/icon-192.png",
    badge:            "/icon-192.png",
    tag:              "vc-call-" + (caller || Date.now()),
    renotify:         true,
    requireInteraction: true,                          // jab tak dismiss na karo, band nahi hogi
    silent:           false,
    vibrate:          [400, 150, 400, 150, 400, 150, 600],
    timestamp:        Date.now(),
    data:             { url, caller, type: data.type || "incoming-call" },
    actions: [
      { action: "accept",  title: "📞 Accept"  },
      { action: "decline", title: "📵 Decline" }
    ]
  };

  event.waitUntil(
    // Agar app already open + focused hai to push show mat karo
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const focused = clientList.some((c) => c.focused && c.url.includes(self.location.origin));
      if (!focused) {
        return self.registration.showNotification(title, options);
      }
      // App open hai — directly message bhejo
      clientList.forEach((c) => {
        if (c.url.includes(self.location.origin)) {
          c.postMessage({ type: "push-in-app", data });
        }
      });
    })
  );
});

// ── NOTIFICATION CLICK ────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const { url, caller, type } = event.notification.data || {};
  const action = event.action;

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Existing tab dhundo
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.focus();
          // App ko batao kya hua
          client.postMessage({
            type: "notification-action",
            action,                   // "accept" | "decline" | ""
            caller,
            notifType: type
          });
          return;
        }
      }
      // Koi tab nahi — naya kholo
      const openUrl = url || "/";
      return clients.openWindow(openUrl).then((newClient) => {
        if (newClient) {
          // Thoda wait karo page load ke liye
          setTimeout(() => {
            newClient.postMessage({
              type: "notification-action",
              action,
              caller,
              notifType: type
            });
          }, 2500);
        }
      });
    })
  );
});

// ── NOTIFICATION CLOSE (user ne X dabaya) ────────────
self.addEventListener("notificationclose", (event) => {
  const { caller } = event.notification.data || {};
  // App ko inform karo ki notification dismiss hui
  clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    list.forEach((c) => {
      if (c.url.includes(self.location.origin)) {
        c.postMessage({ type: "notification-dismissed", caller });
      }
    });
  });
});

// ── MESSAGE FROM PAGE ─────────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});
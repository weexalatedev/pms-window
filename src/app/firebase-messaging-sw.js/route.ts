export const dynamic = 'force-dynamic';

export async function GET() {
  const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '',
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '',
  };

  if (!firebaseConfig.apiKey || !firebaseConfig.projectId || !firebaseConfig.messagingSenderId) {
    return new Response('Firebase messaging is not configured.', { status: 503 });
  }

  const workerScript = `
// Our push handler is registered BEFORE the Firebase SDK loads so it runs
// first and stops Firebase's own handler. Firebase skips the notification
// whenever an app window is open, but Safari/iOS requires every push to show
// one (userVisibleOnly) and revokes the subscription after a few silent pushes.
// So we always show it here, and tell open windows so the in-app bell updates.
self.addEventListener('push', (event) => {
  event.stopImmediatePropagation();

  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { data: { body: event.data ? event.data.text() : '' } };
  }
  const data = payload.data || {};
  const notification = payload.notification || {};
  const title = data.title || notification.title || 'Unique Arts PMS';
  const body = data.body || notification.body || '';
  const priority = data.priority || 'normal';
  const tag = data.tag || undefined;
  const url = data.url || data.click_action || '/';

  const show = self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-192x192.png',
    tag,
    // Re-alert when a grouped notification is replaced with newer info.
    renotify: Boolean(tag) && priority !== 'low',
    // Urgent items stay on screen until handled; FYI items arrive quietly.
    requireInteraction: priority === 'high',
    silent: priority === 'low',
    timestamp: Date.now(),
    data: Object.assign({}, data, { url }),
  });

  const informWindows = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((windowClients) => {
      windowClients.forEach((client) =>
        client.postMessage({ type: 'pms-push', data: Object.assign({}, data, { title, body, url }) })
      );
    });

  event.waitUntil(Promise.all([show, informWindows]));
});

importScripts('https://www.gstatic.com/firebasejs/12.14.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.14.0/firebase-messaging-compat.js');

// Activate updated workers immediately so notification fixes ship on deploy.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Firebase stays initialised for token lifecycle handling; delivery is ours.
firebase.initializeApp(${JSON.stringify(firebaseConfig)});
firebase.messaging();

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && (event.notification.data.url || event.notification.data.click_action)) || '/',
    self.location.origin
  );
  // Never navigate to another origin from a push payload.
  const url = target.origin === self.location.origin ? target.href : self.location.origin + '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.startsWith(self.location.origin)) {
          return client.focus().then((focused) =>
            focused && 'navigate' in focused && focused.url !== url ? focused.navigate(url) : focused
          );
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
`;

  return new Response(workerScript, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
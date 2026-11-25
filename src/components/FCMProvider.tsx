'use client';

import { useEffect } from 'react';
import { useUser } from '@clerk/nextjs';
import { NotificationType } from '@/types/notifications';

/**
 * FCM (Firebase Cloud Messaging) provider.
 *
 * The Firebase SDK (~100 KB) is loaded lazily after sign-in so it never blocks
 * the first paint or the dashboard bundle.
 *
 * 1. Silently refreshes the FCM token when the user already granted push
 *    permission (never prompts automatically — browsers block that).
 * 2. Re-registers instantly after the user enables push from the bell.
 * 3. Converts foreground push messages into in-app notification events.
 * 4. Clears the token on sign-out.
 */
export default function FCMProvider() {
  const { isSignedIn, isLoaded } = useUser();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let unregisterPushEnabled: (() => void) | null = null;

    const setup = async () => {
      const { getPushPermission, registerFcmTokenOnServer, requestFcmToken } =
        await import('@/lib/firebase');
      if (cancelled) return;

      const registerIfAllowed = async () => {
        if (getPushPermission() !== 'granted') return;
        if (window.localStorage.getItem('pms-push-disabled') === 'true') return;

        // requestPermission: false keeps this silent; the user already opted in.
        const token = await requestFcmToken({ requestPermission: false });
        if (cancelled || !token) return;
        await registerFcmTokenOnServer(token);
      };

      // The service worker shows every push as a system notification (iOS
      // requires that) and posts it here so the in-app bell updates live.
      const handleWorkerMessage = (event: MessageEvent) => {
        const message = event.data as { type?: string; data?: Record<string, string> } | null;
        if (!message || message.type !== 'pms-push') return;
        const data = message.data || {};
        const title = data.title;
        if (!title) return;

        const body = data.body || '';
        const link = data.url || data.click_action || '/';

        window.dispatchEvent(
          new CustomEvent('pms-notification', {
            detail: {
              type: data.type || NotificationType.ALERT_CREATED,
              title,
              body,
              link,
              metadata: data,
            },
          })
        );
      };

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', handleWorkerMessage);
        unsubscribe = () => navigator.serviceWorker.removeEventListener('message', handleWorkerMessage);
      }

      void registerIfAllowed();
      window.addEventListener('pms-push-enabled', registerIfAllowed);
      unregisterPushEnabled = () => window.removeEventListener('pms-push-enabled', registerIfAllowed);
    };

    void setup();

    return () => {
      cancelled = true;
      unsubscribe?.();
      unregisterPushEnabled?.();
    };
  }, [isLoaded, isSignedIn]);

  // Clear the server-side token when the user signs out.
  useEffect(() => {
    if (!isLoaded || isSignedIn) return;
    // Only devices that registered push need cleanup; this avoids loading
    // Firebase on the sign-in page for everyone else.
    try {
      if (!window.localStorage.getItem('pms-fcm-token')) return;
    } catch {
      return;
    }
    void import('@/lib/firebase').then(({ removeFcmToken }) => removeFcmToken());
  }, [isLoaded, isSignedIn]);

  return null;
}

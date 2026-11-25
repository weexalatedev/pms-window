'use client';

import { useCallback, useEffect, useState } from 'react';

type PushStatus = NotificationPermission | 'unsupported';

const DISABLED_KEY = 'pms-push-disabled';

function supportsPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

function readPermission(): PushStatus {
  return supportsPush() ? Notification.permission : 'unsupported';
}

/**
 * iPhone/iPad Safari only supports web push for apps added to the Home
 * Screen (iOS 16.4+). In a normal Safari tab PushManager is missing, so tell
 * the user how to install instead of "not supported".
 */
function needsHomeScreenInstall(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return isIOS && !standalone;
}

function readMuted(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(DISABLED_KEY) === 'true';
}

/**
 * Push-notification controls for the bell / settings UI.
 *
 * Permission is only requested from a user gesture (the "Enable" button) —
 * browsers block automatic prompts, which is why push previously never
 * activated on first load. Firebase is imported on demand so it stays out of
 * the initial bundle.
 */
export function usePushNotifications() {
  const [status, setStatus] = useState<PushStatus>('default');
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStatus(readPermission());
    setMuted(readMuted());
  }, []);

  const enable = useCallback(async (): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      // Ask for permission first, directly inside the click. Safari (iOS)
      // ignores the prompt if we await a network import before asking.
      if (supportsPush() && Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setStatus(readPermission());
          return false;
        }
      }
      const { requestFcmToken, registerFcmTokenOnServer } = await import('@/lib/firebase');
      const token = await requestFcmToken();
      if (!token) {
        setStatus(readPermission());
        return false;
      }
      const registered = await registerFcmTokenOnServer(token, { force: true });
      if (!registered) return false;

      window.localStorage.removeItem(DISABLED_KEY);
      setMuted(false);
      setStatus('granted');
      window.dispatchEvent(new CustomEvent('pms-push-enabled'));
      return true;
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const { removeFcmToken } = await import('@/lib/firebase');
      await removeFcmToken();
      window.localStorage.setItem(DISABLED_KEY, 'true');
      setMuted(true);
      window.dispatchEvent(new CustomEvent('pms-push-disabled'));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    supported: supportsPush(),
    /** iOS Safari tab: push works only after "Add to Home Screen". */
    needsInstall: needsHomeScreenInstall(),
    status,
    /** True only when the browser granted permission and the user did not mute. */
    enabled: status === 'granted' && !muted,
    denied: status === 'denied',
    busy,
    enable,
    disable,
  };
}

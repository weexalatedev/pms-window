'use client';

import { useEffect, useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { BellRing, Loader2, X } from 'lucide-react';
import { usePushNotifications } from '@/hooks/usePushNotifications';

const DISMISSED_KEY = 'pms-push-banner-dismissed';

export function PushNotificationBanner() {
  const { isLoaded, isSignedIn } = useUser();
  const push = usePushNotifications();
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setMounted(true);
    try {
      setDismissed(window.localStorage.getItem(DISMISSED_KEY) === 'true');
    } catch {
      setDismissed(false);
    }
  }, []);

  if (!mounted || !isLoaded || !isSignedIn || dismissed || push.enabled) return null;
  if (!push.needsInstall && !push.supported && !push.denied) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      // The banner remains dismissed for this page view.
    }
  };

  const enable = async () => {
    setError('');
    const enabled = await push.enable();
    if (!enabled) {
      setError(
        push.denied
          ? 'Notifications are blocked. Allow them for this site in your browser or device settings, then try again.'
          : 'Notifications could not be enabled. Check your browser permissions and try again.'
      );
    }
  };

  return (
    <aside
      role="region"
      aria-label="Push notification setup"
      aria-live="polite"
      className="flex flex-col gap-3 border-b border-primary-200 bg-primary-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6"
    >
      <div className="flex items-start gap-3">
        <BellRing className="mt-0.5 h-4 w-4 flex-shrink-0 text-dark-500" />
        <div>
          <p className="text-xs font-bold text-dark-500">
            {push.needsInstall
              ? 'Enable notifications on your iPhone or iPad'
              : push.denied
                ? 'Notifications are blocked on this device'
                : 'Stay up to date with notifications'}
          </p>
          <p className="mt-0.5 text-[11px] text-primary-500">
            {push.needsInstall
              ? 'Add this app to your Home Screen, open it from there, then enable notifications (iOS/iPadOS 16.4 or later).'
              : push.denied
                ? 'Allow notifications for this site in browser or device settings, then return here.'
                : 'Turn on push notifications to receive important updates when you are away from the app.'}
          </p>
          {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
        </div>
      </div>

      <div className="flex items-center gap-2 pl-7 sm:pl-0">
        {push.supported && !push.denied && !push.needsInstall && (
          <button
            type="button"
            onClick={() => void enable()}
            disabled={push.busy}
            className="inline-flex items-center gap-1.5 bg-dark-500 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-white hover:bg-dark-600 disabled:opacity-50"
          >
            {push.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <BellRing className="h-3 w-3" />}
            Enable
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss notification prompt"
          className="p-1 text-primary-400 hover:text-dark-500"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}

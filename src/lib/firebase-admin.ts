/**
 * firebase-admin.ts
 *
 * Firebase Admin SDK wrapper for sending FCM web push from the server.
 *
 * Design notes:
 * - Messages are **data-only**. The service worker (/firebase-messaging-sw.js)
 *   renders them itself, which avoids the duplicate notification FCM shows when
 *   a `notification` payload *and* an onBackgroundMessage handler both exist,
 *   and lets us control tag/priority/actions.
 * - Sends are batched with `sendEachForMulticast` (500 tokens per call) instead
 *   of one HTTP request per device.
 * - Tokens FCM reports as dead are returned so callers can prune them.
 * - firebase-admin is imported lazily so builds never require credentials.
 */

import type { Messaging } from 'firebase-admin/messaging';

export type PushPriority = 'high' | 'normal' | 'low';

export interface PushMessage {
  title: string;
  body: string;
  link?: string;
  /** Notifications with the same tag replace each other on the device. */
  tag?: string;
  priority?: PushPriority;
  data?: Record<string, string>;
}

export interface PushResult {
  success: number;
  failed: number;
  /** Tokens that are permanently invalid and should be removed. */
  invalidTokens: string[];
}

const MULTICAST_LIMIT = 500;

const PERMANENT_TOKEN_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/** Strip surrounding quotes/whitespace that some hosts leave on env values */
function cleanEnv(value: string | undefined): string {
  return (value || '').trim().replace(/^["']|["']$/g, '');
}

/** Check if Firebase Admin credentials are configured */
export function isFcmConfigured(): boolean {
  return !!(
    cleanEnv(process.env.FIREBASE_PROJECT_ID) &&
    cleanEnv(process.env.FIREBASE_CLIENT_EMAIL) &&
    cleanEnv(process.env.FIREBASE_PRIVATE_KEY)
  );
}

let messagingPromise: Promise<Messaging> | null = null;

/** Lazily initialise the Admin SDK once per server instance. */
function getAdminMessaging(): Promise<Messaging> {
  if (!messagingPromise) {
    messagingPromise = (async () => {
      const { initializeApp, getApps, cert } = await import('firebase-admin/app');
      const { getMessaging } = await import('firebase-admin/messaging');

      if (getApps().length === 0) {
        initializeApp({
          credential: cert({
            projectId: cleanEnv(process.env.FIREBASE_PROJECT_ID),
            clientEmail: cleanEnv(process.env.FIREBASE_CLIENT_EMAIL),
            // Env values often store newlines as literal "\n" — restore them.
            privateKey: cleanEnv(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n'),
          }),
        });
      }
      return getMessaging();
    })().catch((error) => {
      messagingPromise = null; // allow a retry on the next send
      throw error;
    });
  }
  return messagingPromise;
}

const TTL_SECONDS: Record<PushPriority, number> = {
  high: 60 * 60 * 24, // alerts / mentions stay deliverable for a day
  normal: 60 * 60 * 12,
  low: 60 * 60 * 4, // FYI-style pushes are pointless once stale
};

/**
 * Send one push to many device tokens. Never throws.
 */
export async function sendPushToTokens(tokens: string[], message: PushMessage): Promise<PushResult> {
  const uniqueTokens = Array.from(new Set(tokens.filter(Boolean)));
  const result: PushResult = { success: 0, failed: 0, invalidTokens: [] };
  if (uniqueTokens.length === 0) return result;

  if (!isFcmConfigured()) {
    console.warn('[FCM] Firebase Admin not configured — skipping push');
    result.failed = uniqueTokens.length;
    return result;
  }

  const priority = message.priority || 'normal';
  const link = message.link || '/';

  // Data payload values must all be strings.
  const data: Record<string, string> = {
    ...(message.data || {}),
    title: message.title,
    body: message.body,
    url: link,
    tag: message.tag || '',
    priority,
  };

  let messaging: Messaging;
  try {
    messaging = await getAdminMessaging();
  } catch (error) {
    console.error('[FCM] Admin SDK init failed:', error);
    result.failed = uniqueTokens.length;
    return result;
  }

  for (let i = 0; i < uniqueTokens.length; i += MULTICAST_LIMIT) {
    const batch = uniqueTokens.slice(i, i + MULTICAST_LIMIT);
    try {
      const response = await messaging.sendEachForMulticast({
        tokens: batch,
        data,
        webpush: {
          headers: {
            Urgency: priority === 'low' ? 'low' : priority === 'high' ? 'high' : 'normal',
            TTL: String(TTL_SECONDS[priority]),
            ...(message.tag ? { Topic: sanitizeTopic(message.tag) } : {}),
          },
          fcmOptions: { link },
        },
      });

      result.success += response.successCount;
      result.failed += response.failureCount;

      response.responses.forEach((r, index) => {
        if (!r.success && r.error && PERMANENT_TOKEN_ERRORS.has(r.error.code)) {
          result.invalidTokens.push(batch[index]);
        }
      });
    } catch (error) {
      console.error('[FCM] Multicast send failed:', error);
      result.failed += batch.length;
    }
  }

  if (result.failed > 0) {
    console.warn(
      `[FCM] Delivered ${result.success}/${uniqueTokens.length} (${result.invalidTokens.length} dead tokens)`
    );
  }
  return result;
}

/**
 * Web Push `Topic` header: max 32 chars from the URL-safe base64 alphabet.
 * A pending message with the same topic is replaced while the device is
 * offline, so a burst of updates to one task only delivers the latest.
 */
function sanitizeTopic(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, '').slice(-32) || 'pms';
}

/**
 * Backwards-compatible helper used by the admin push tester.
 */
export async function sendFcmPushToUsers(
  tokens: string[],
  title: string,
  body: string,
  link?: string,
  data?: Record<string, string>,
): Promise<PushResult> {
  return sendPushToTokens(tokens, { title, body, link, data, priority: 'high', tag: 'pms-test' });
}

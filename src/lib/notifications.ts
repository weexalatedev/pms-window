/**
 * notifications.ts
 *
 * Unified notification service. Every notification is:
 * 1. Persisted to MongoDB for the in-app bell (always, synced across devices).
 * 2. Pushed via Firebase Cloud Messaging to every device the user enabled.
 *
 * "Intelligent" delivery rules:
 * - Never blocks the API response: delivery runs after the response is sent
 *   (Next.js `after()`), so mutations stay fast even when FCM is slow.
 * - Priority per type: alerts and mentions are urgent (stay on screen,
 *   long TTL); FYI pushes like "new project" are low priority.
 * - Collapsing: pushes about the same alert/task/discussion share a tag, so a
 *   flurry of updates replaces one notification instead of stacking.
 * - Burst control: when a user receives many notifications in a short window,
 *   non-urgent pushes are folded into a single "N new updates" summary.
 * - Preferences: users can mute push for non-critical types; the bell still
 *   records everything. Alerts can't be muted.
 * - Self-healing: tokens FCM reports as dead are removed automatically.
 */

import { after } from 'next/server';
import { Types } from 'mongoose';
import connectDB from '@/lib/db';
import { isFcmConfigured, sendPushToTokens, type PushPriority } from '@/lib/firebase-admin';
import { NotificationType } from '@/types/notifications';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RichNotificationConfig {
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  userIds: string[];
  /** Users that should never receive this notification (e.g. the actor). */
  excludeUserIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface NotifyOptions {
  /**
   * Run delivery after the HTTP response has been sent (default).
   * Pass `false` from cron jobs/scripts that must finish the work inline.
   */
  defer?: boolean;
}

// ─── Per-type behaviour ───────────────────────────────────────────────────────

/** Emoji + accent colour for each notification type. */
export function getNotificationIcon(type: NotificationType): { emoji: string; hexColor: string } {
  switch (type) {
    case NotificationType.ALERT_CREATED:
      return { emoji: '🚨', hexColor: '#DC2626' };
    case NotificationType.ALERT_ACKNOWLEDGED:
      return { emoji: '👀', hexColor: '#D97706' };
    case NotificationType.ALERT_RESOLVED:
      return { emoji: '✅', hexColor: '#059669' };
    case NotificationType.TASK_ASSIGNED:
    case NotificationType.INTERNAL_TASK_ASSIGNED:
      return { emoji: '📋', hexColor: '#2563EB' };
    case NotificationType.TASK_STATUS_CHANGED:
      return { emoji: '🔄', hexColor: '#7C3AED' };
    case NotificationType.TASK_OVERDUE:
      return { emoji: '⏰', hexColor: '#DC2626' };
    case NotificationType.TASK_PENDING:
      return { emoji: '📋', hexColor: '#D97706' };
    case NotificationType.COMMENT_MENTION:
      return { emoji: '💬', hexColor: '#D97706' };
    case NotificationType.DISCUSSION_REPLY:
      return { emoji: '💬', hexColor: '#14B8A6' };
    case NotificationType.DISCUSSION_CREATED:
      return { emoji: '💡', hexColor: '#14B8A6' };
    case NotificationType.PROJECT_CREATED:
      return { emoji: '📦', hexColor: '#0891B2' };
    default:
      return { emoji: '🔔', hexColor: '#6B7280' };
  }
}

function getPriority(type: NotificationType, metadata?: Record<string, unknown>): PushPriority {
  switch (type) {
    case NotificationType.ALERT_CREATED:
      return metadata?.severity === 'low' ? 'normal' : 'high';
    case NotificationType.COMMENT_MENTION:
    case NotificationType.TASK_ASSIGNED:
    case NotificationType.INTERNAL_TASK_ASSIGNED:
    case NotificationType.TASK_OVERDUE:
      return 'high';
    case NotificationType.TASK_PENDING:
      return Number(metadata?.overdueCount) > 0 ? 'high' : 'normal';
    case NotificationType.PROJECT_CREATED:
    case NotificationType.DISCUSSION_CREATED:
      return 'low';
    default:
      return 'normal';
  }
}

/** Types users are not allowed to mute — production-blocking alerts. */
export const UNMUTABLE_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  NotificationType.ALERT_CREATED,
]);

/**
 * Pushes about the same entity share a tag so the device shows only the
 * latest one (e.g. three status changes on a task → one notification).
 */
function getCollapseTag(type: NotificationType, metadata?: Record<string, unknown>): string {
  const id = (key: string) => (metadata?.[key] ? String(metadata[key]) : '');
  if (id('alertId')) return `alert-${id('alertId')}`;
  if (id('discussionId')) return `disc-${id('discussionId')}`;
  if (id('taskId')) return `task-${id('taskId')}`;
  if (type === NotificationType.TASK_PENDING || type === NotificationType.TASK_OVERDUE) return 'task-digest';
  if (id('projectId')) return `proj-${id('projectId')}`;
  return `type-${type}`;
}

/** Prefix a title with its emoji unless the caller already included one. */
function withIcon(title: string, emoji: string): string {
  return /^\p{Extended_Pictographic}/u.test(title.trim()) ? title : `${emoji} ${title}`;
}

/** Turn arbitrary metadata values into strings, as required by FCM. */
function toFcmData(metadata: Record<string, unknown> | undefined): Record<string, string> {
  if (!metadata) return {};
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    // FCM rejects these reserved keys.
    if (key === 'from' || key === 'notification' || key === 'message_type' || /^(google|gcm)/i.test(key)) continue;
    data[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return data;
}

// Burst control: more than BURST_LIMIT notifications within BURST_WINDOW_MS
// turns non-urgent pushes into a single rolling summary.
const BURST_WINDOW_MS = 2 * 60 * 1000;
const BURST_LIMIT = 4;

// ─── Unified Dispatch ─────────────────────────────────────────────────────────

/**
 * Send a notification to users via the in-app bell and push.
 * Returns immediately; delivery happens after the response by default.
 */
export async function notifyUsers(config: RichNotificationConfig, options: NotifyOptions = {}): Promise<void> {
  const excluded = new Set((config.excludeUserIds || []).map(String));
  const userIds = Array.from(new Set(config.userIds.map(String))).filter(
    (id) => id && !excluded.has(id) && Types.ObjectId.isValid(id)
  );
  if (userIds.length === 0) return;

  const task = () => deliver({ ...config, userIds });

  if (options.defer === false) {
    await task();
    return;
  }

  try {
    // Keeps the serverless function alive until delivery finishes, without
    // making the user wait for it.
    after(task);
  } catch {
    // Called outside a request scope (scripts) — run inline.
    await task();
  }
}

async function deliver(config: RichNotificationConfig): Promise<void> {
  const { type, title, body, link, metadata, userIds } = config;
  const icon = getNotificationIcon(type);
  const displayTitle = withIcon(title, icon.emoji);

  try {
    await connectDB();
  } catch (error) {
    console.error('[notifications] DB unavailable, dropping notification:', error);
    return;
  }

  const NotificationModel = (await import('@/models/Notification')).default;

  try {
    await NotificationModel.insertMany(
      userIds.map((userId) => ({
        userId,
        type,
        title: displayTitle,
        body,
        link,
        read: false,
        dismissed: false,
        metadata: { ...(metadata || {}), icon: icon.emoji, color: icon.hexColor },
      })),
      { ordered: false }
    );
  } catch (error) {
    // The bell is the primary channel — log but keep going with push.
    console.error('[notifications] Failed to persist in-app notification:', error);
  }

  if (!isFcmConfigured()) return;

  try {
    await sendPush({ type, displayTitle, body, link, metadata, userIds, color: icon.hexColor, emoji: icon.emoji });
  } catch (error) {
    console.error('[notifications] Push delivery failed:', error);
  }
}

interface PushContext {
  type: NotificationType;
  displayTitle: string;
  body: string;
  link: string;
  metadata?: Record<string, unknown>;
  userIds: string[];
  color: string;
  emoji: string;
}

async function sendPush(ctx: PushContext): Promise<void> {
  const UserModel = (await import('@/models/User')).default;
  const NotificationModel = (await import('@/models/Notification')).default;

  const users = await UserModel.find({
    _id: { $in: ctx.userIds },
    isActive: true,
    $or: [{ 'fcmTokens.0': { $exists: true } }, { fcmToken: { $nin: ['', null] } }],
  })
    .select('fcmToken fcmTokens.token notificationPrefs')
    .lean();

  if (users.length === 0) return;

  const priority = getPriority(ctx.type, ctx.metadata);
  const canMute = !UNMUTABLE_NOTIFICATION_TYPES.has(ctx.type);

  const recipients = users
    .filter((u) => !(canMute && u.notificationPrefs?.mutedTypes?.includes(ctx.type)))
    .map((u) => ({
      id: String(u._id),
      tokens: Array.from(
        new Set([...(u.fcmTokens || []).map((t) => t.token), u.fcmToken || ''].filter(Boolean))
      ),
    }))
    .filter((r) => r.tokens.length > 0);

  if (recipients.length === 0) return;

  // Burst detection: one aggregate for all recipients (uses userId+createdAt index).
  const recentCounts = new Map<string, number>();
  if (priority !== 'high') {
    const since = new Date(Date.now() - BURST_WINDOW_MS);
    const counts = await NotificationModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      {
        $match: {
          userId: { $in: recipients.map((r) => new Types.ObjectId(r.id)) },
          createdAt: { $gte: since },
        },
      },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]);
    counts.forEach((c) => recentCounts.set(String(c._id), c.count));
  }

  const normalTokens: string[] = [];
  // Summaries differ per count, so group burst recipients by count.
  const digestTokensByCount = new Map<number, string[]>();

  for (const r of recipients) {
    const recent = recentCounts.get(r.id) || 0;
    if (recent > BURST_LIMIT) {
      const list = digestTokensByCount.get(recent) || [];
      list.push(...r.tokens);
      digestTokensByCount.set(recent, list);
    } else {
      normalTokens.push(...r.tokens);
    }
  }

  const baseData = {
    type: ctx.type,
    icon: ctx.emoji,
    color: ctx.color,
    ...toFcmData(ctx.metadata),
  };

  const sends: Promise<{ invalidTokens: string[] }>[] = [];

  if (normalTokens.length > 0) {
    sends.push(
      sendPushToTokens(normalTokens, {
        title: ctx.displayTitle,
        body: ctx.body,
        link: ctx.link,
        tag: getCollapseTag(ctx.type, ctx.metadata),
        priority,
        data: baseData,
      })
    );
  }

  for (const [count, tokens] of digestTokensByCount) {
    sends.push(
      sendPushToTokens(tokens, {
        title: `🔔 ${count} new updates`,
        body: `Latest: ${ctx.displayTitle}`,
        link: '/dashboard',
        tag: 'pms-digest', // each summary replaces the previous one
        priority: 'low',
        data: { type: 'digest', count: String(count) },
      })
    );
  }

  const results = await Promise.all(sends);
  const invalid = results.flatMap((r) => r.invalidTokens);
  if (invalid.length > 0) await pruneInvalidTokens(invalid);
}

/** Remove tokens FCM says are no longer valid from every user. */
export async function pruneInvalidTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  try {
    const UserModel = (await import('@/models/User')).default;
    await Promise.all([
      UserModel.updateMany(
        { 'fcmTokens.token': { $in: tokens } },
        { $pull: { fcmTokens: { token: { $in: tokens } } } }
      ),
      UserModel.updateMany({ fcmToken: { $in: tokens } }, { $set: { fcmToken: '' } }),
    ]);
  } catch (error) {
    console.warn('[notifications] Failed to prune invalid tokens:', error);
  }
}

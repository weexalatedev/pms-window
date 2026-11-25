/**
 * Scheduled / batch notification jobs.
 *
 * Triggered by the Vercel cron (/api/cron/notifications) every morning, and
 * opportunistically by admins (the internal-tasks page). Both paths are safe
 * to run repeatedly: each user gets at most one digest per day.
 */

import { Types } from 'mongoose';
import connectDB from '@/lib/db';
import NotificationModel from '@/models/Notification';
import TaskModel from '@/models/Task';
import { TaskStatus } from '@/types';
import { NotificationType } from '@/types/notifications';
import { notifyUsers, type NotifyOptions } from '@/lib/notifications';
import { getArchivedProjectIds } from '@/lib/task-archive';

interface DigestTask {
  projectId?: Types.ObjectId | null;
  dueDate?: Date | null;
  assignedUser?: Types.ObjectId | null;
}

/**
 * Send one daily summary of unfinished assigned tasks to each assignee,
 * highlighting what is overdue or due within 3 days.
 */
export async function runPendingTaskDigest(options: NotifyOptions = {}): Promise<{ notified: number }> {
  await connectDB();

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueSoonLimit = new Date(now);
  dueSoonLimit.setDate(dueSoonLimit.getDate() + 3);

  // Live-only: skip tasks of completed (archived) projects.
  const archivedIds = await getArchivedProjectIds();
  const [pendingTasks, alreadyNotified] = await Promise.all([
    TaskModel.find({
      status: { $ne: TaskStatus.DONE },
      assignedUser: { $ne: null },
      ...(archivedIds.length > 0
        ? { $or: [{ projectId: null }, { projectId: { $nin: archivedIds } }] }
        : {}),
    })
      .select('projectId dueDate assignedUser')
      .lean<DigestTask[]>(),
    // One query for "who already got today's digest" instead of one per user.
    NotificationModel.distinct('userId', {
      type: NotificationType.TASK_PENDING,
      createdAt: { $gte: todayStart },
    }),
  ]);

  const skip = new Set(alreadyNotified.map(String));
  const byUser = new Map<string, DigestTask[]>();
  for (const task of pendingTasks) {
    const userId = task.assignedUser ? String(task.assignedUser) : '';
    if (!userId || skip.has(userId)) continue;
    const list = byUser.get(userId) || [];
    list.push(task);
    byUser.set(userId, list);
  }

  for (const [userId, tasks] of byUser) {
    const taskCount = tasks.length;
    const overdueCount = tasks.filter((t) => t.dueDate && new Date(t.dueDate) < now).length;
    const dueSoonCount = tasks.filter((t) => {
      if (!t.dueDate) return false;
      const due = new Date(t.dueDate);
      return due >= now && due <= dueSoonLimit;
    }).length;

    const urgency = [
      overdueCount > 0 ? `${overdueCount} overdue` : '',
      dueSoonCount > 0 ? `${dueSoonCount} due within 3 days` : '',
    ]
      .filter(Boolean)
      .join(', ');

    const hasProjectTasks = tasks.some((t) => Boolean(t.projectId));

    await notifyUsers(
      {
        // Push priority escalates to "high" when anything is overdue (see getPriority).
        type: NotificationType.TASK_PENDING,
        title:
          overdueCount > 0
            ? `${overdueCount} overdue task${overdueCount === 1 ? '' : 's'} — ${taskCount} pending`
            : `${taskCount} pending task${taskCount === 1 ? '' : 's'} need attention`,
        body: urgency
          ? `You have ${taskCount} unfinished assigned task${taskCount === 1 ? '' : 's'}. ${urgency}.`
          : `You have ${taskCount} unfinished assigned task${taskCount === 1 ? '' : 's'}. Review your task list when you can.`,
        link: hasProjectTasks ? '/tasks' : '/internal-tasks',
        userIds: [userId],
        metadata: { taskCount, overdueCount, dueSoonCount, isInternal: !hasProjectTasks },
      },
      options
    );
  }

  return { notified: byUser.size };
}

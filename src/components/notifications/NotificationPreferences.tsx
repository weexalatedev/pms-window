'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { apiFetch, cn } from '@/lib/utils';
import { NotificationType } from '@/types/notifications';

/** User-facing groups; each maps to one or more notification types. */
const GROUPS: Array<{ label: string; hint: string; types: NotificationType[] }> = [
  {
    label: 'Task assignments',
    hint: 'When a task is assigned to you',
    types: [NotificationType.TASK_ASSIGNED, NotificationType.INTERNAL_TASK_ASSIGNED],
  },
  { label: 'Task updates', hint: 'Status changes on your tasks', types: [NotificationType.TASK_STATUS_CHANGED] },
  { label: 'Comments & mentions', hint: '@mentions and comments on your work', types: [NotificationType.COMMENT_MENTION] },
  {
    label: 'Discussions',
    hint: 'New threads and replies',
    types: [NotificationType.DISCUSSION_CREATED, NotificationType.DISCUSSION_REPLY],
  },
  {
    label: 'Alert follow-ups',
    hint: 'Acknowledged / resolved alerts',
    types: [NotificationType.ALERT_ACKNOWLEDGED, NotificationType.ALERT_RESOLVED],
  },
  { label: 'New projects', hint: 'When a project is created', types: [NotificationType.PROJECT_CREATED] },
  {
    label: 'Daily task digest',
    hint: 'Morning summary of pending & overdue tasks',
    types: [NotificationType.TASK_PENDING, NotificationType.TASK_OVERDUE],
  },
];

/**
 * Per-user push preferences. Muting only affects push on every device; the
 * in-app bell still records everything. New alerts are always pushed.
 */
export function NotificationPreferences() {
  const [open, setOpen] = useState(false);
  const [muted, setMuted] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || muted) return;
    let alive = true;
    apiFetch<{ mutedTypes: string[] }>('/api/push/preferences').then((res) => {
      if (alive) setMuted(new Set(res.success && res.data ? res.data.mutedTypes : []));
    });
    return () => {
      alive = false;
    };
  }, [open, muted]);

  const toggle = async (types: NotificationType[], enable: boolean) => {
    if (!muted) return;
    const previous = muted;
    const next = new Set(muted);
    types.forEach((t) => (enable ? next.delete(t) : next.add(t)));
    setMuted(next); // optimistic
    setSaving(true);
    const res = await apiFetch('/api/push/preferences', {
      method: 'PUT',
      body: JSON.stringify({ mutedTypes: Array.from(next) }),
    });
    if (!res.success) setMuted(previous);
    setSaving(false);
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[9px] font-mono text-primary-500 hover:text-dark-500 flex items-center gap-1"
        aria-expanded={open}
      >
        <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
        Choose what to push
        {saving && <Loader2 className="w-3 h-3 animate-spin" />}
      </button>

      {open && (
        <div className="mt-2 space-y-1.5">
          {!muted ? (
            <div className="flex items-center gap-1.5 text-[9px] font-mono text-primary-400">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              {GROUPS.map((group) => {
                const on = group.types.every((t) => !muted.has(t));
                return (
                  <label key={group.label} className="flex items-center justify-between gap-2 cursor-pointer">
                    <span className="min-w-0">
                      <span className="block text-[10px] font-mono text-dark-500">{group.label}</span>
                      <span className="block text-[9px] font-mono text-primary-400 truncate">{group.hint}</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => void toggle(group.types, e.target.checked)}
                      className="h-3.5 w-3.5 accent-dark-500 flex-shrink-0"
                    />
                  </label>
                );
              })}
              <p className="text-[9px] font-mono text-primary-400 pt-1">
                New alerts are always pushed. Everything still appears in this bell.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

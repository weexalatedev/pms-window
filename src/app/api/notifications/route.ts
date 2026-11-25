import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import NotificationModel from '@/models/Notification';
import { withAuth } from '@/lib/auth';
import { UserRole } from '@/types';
import { runPendingTaskDigest } from '@/lib/notification-jobs';

// GET /api/notifications — fetch current user's notifications
export const GET = withAuth(async (req: NextRequest, _ctx, { user }) => {
  await connectDB();

  const searchParams = req.nextUrl.searchParams;
  const parsedLimit = parseInt(searchParams.get('limit') || '50', 10);
  const limit = Math.min(100, Math.max(1, Number.isNaN(parsedLimit) ? 50 : parsedLimit));
  const includeDismissed = searchParams.get('includeDismissed') === 'true';
  const unreadOnly = searchParams.get('unreadOnly') === 'true';

  const query: Record<string, unknown> = { userId: user._id };

  if (!includeDismissed) {
    query.dismissed = false;
  }
  if (unreadOnly) {
    query.read = false;
  }

  const [notifications, unreadCount] = await Promise.all([
    NotificationModel.find(query)
      .select('type title body link createdAt read dismissed metadata')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),
    NotificationModel.countDocuments({
      userId: user._id,
      read: false,
      dismissed: false,
    }),
  ]);

  // Serialize for client
  const serialized = notifications.map((n) => {
    const id = n._id instanceof Object ? n._id.toString() : String(n._id);
    return {
      id,
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link,
      timestamp: n.createdAt,
      read: n.read,
      dismissed: n.dismissed,
      metadata: n.metadata,
    };
  });

  return NextResponse.json({
    success: true,
    data: { items: serialized, unreadCount },
  });
});

// POST /api/notifications/mark-all-read — mark all notifications as read
export const POST = withAuth(async (req: NextRequest, _ctx, { user }) => {
  await connectDB();

  const body = await req.json().catch(() => ({}));
  const action = body.action;

  if (action === 'mark-all-read') {
    await NotificationModel.updateMany(
      { userId: user._id, read: false, dismissed: false },
      { $set: { read: true } }
    );

    return NextResponse.json({ success: true });
  }

  if (action === 'clear-all') {
    await NotificationModel.updateMany(
      { userId: user._id, dismissed: false },
      { $set: { dismissed: true } }
    );

    return NextResponse.json({ success: true });
  }

  if (action === 'pending-task-check') {
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.SUPER_ADMIN) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }
    await runPendingTaskDigest();
    return NextResponse.json({ success: true });
  }

  return NextResponse.json(
    { success: false, error: 'Invalid action' },
    { status: 400 }
  );
});

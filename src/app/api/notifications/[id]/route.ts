import { NextRequest, NextResponse } from 'next/server';
import { Types } from 'mongoose';
import connectDB from '@/lib/db';
import NotificationModel from '@/models/Notification';
import { withAuth } from '@/lib/auth';

// PATCH /api/notifications/[id] — mark as read or dismiss
export const PATCH = withAuth(async (req: NextRequest, context: { params: Promise<{ id: string }> }, { user }) => {
  const { id } = await context.params;
  await connectDB();

  const body = await req.json().catch(() => ({}));
  const { action } = body as { action?: 'read' | 'dismiss' };

  if (!action || !['read', 'dismiss'].includes(action)) {
    return NextResponse.json(
      { success: false, error: 'Invalid action. Use "read" or "dismiss".' },
      { status: 400 }
    );
  }

  if (!Types.ObjectId.isValid(id)) {
    return NextResponse.json({ success: false, error: 'Notification not found' }, { status: 404 });
  }

  // Single owner-scoped update (no read-then-save round trip).
  const result = await NotificationModel.updateOne(
    { _id: id, userId: user._id },
    { $set: action === 'read' ? { read: true } : { dismissed: true } }
  );

  if (result.matchedCount === 0) {
    return NextResponse.json(
      { success: false, error: 'Notification not found' },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true });
});
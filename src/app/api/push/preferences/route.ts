import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import connectDB from '@/lib/db';
import UserModel from '@/models/User';
import { withAuth } from '@/lib/auth';
import { NotificationType } from '@/types/notifications';
import { UNMUTABLE_NOTIFICATION_TYPES } from '@/lib/notifications';

const PrefsSchema = z.object({
  mutedTypes: z.array(z.nativeEnum(NotificationType)).max(50),
});

// GET /api/push/preferences — current user's push preferences
export const GET = withAuth(async (_req: NextRequest, _ctx, { user }) => {
  return NextResponse.json({
    success: true,
    data: {
      mutedTypes: user.notificationPrefs?.mutedTypes || [],
      deviceCount: (user.fcmTokens || []).length + (user.fcmToken ? 1 : 0),
    },
  });
});

// PUT /api/push/preferences — replace the muted-type list
export const PUT = withAuth(async (req: NextRequest, _ctx, { user }) => {
  const parsed = PrefsSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.flatten() }, { status: 400 });
  }

  const mutedTypes = Array.from(new Set(parsed.data.mutedTypes)).filter(
    (type) => !UNMUTABLE_NOTIFICATION_TYPES.has(type)
  );

  await connectDB();
  await UserModel.updateOne({ _id: user._id }, { $set: { 'notificationPrefs.mutedTypes': mutedTypes } });

  return NextResponse.json({ success: true, data: { mutedTypes } });
});

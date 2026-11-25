import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import connectDB from '@/lib/db';
import UserModel from '@/models/User';
import { withAuth } from '@/lib/auth';

const TokenSchema = z.object({
  token: z.string().min(20).max(4096),
});

/** Keep at most this many devices per user; the least recently seen are dropped. */
const MAX_DEVICES_PER_USER = 10;

// POST /api/push/token — register this device's FCM token for the current user
export const POST = withAuth(async (req: NextRequest, _ctx, { user }) => {
  const parsed = TokenSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 400 });
  }

  await connectDB();
  const { token } = parsed.data;
  const userAgent = (req.headers.get('user-agent') || '').slice(0, 200);

  // A device belongs to whoever is signed in on it now: detach it from any
  // other account so pushes never leak to the previous user of a shared PC.
  await Promise.all([
    UserModel.updateMany(
      { _id: { $ne: user._id }, 'fcmTokens.token': token },
      { $pull: { fcmTokens: { token } } }
    ),
    UserModel.updateMany({ _id: { $ne: user._id }, fcmToken: token }, { $set: { fcmToken: '' } }),
  ]);

  // Upsert this token with a fresh lastSeenAt, newest first, capped.
  await UserModel.updateOne({ _id: user._id }, { $pull: { fcmTokens: { token } } });
  await UserModel.updateOne(
    { _id: user._id },
    {
      $push: {
        fcmTokens: {
          $each: [{ token, userAgent, lastSeenAt: new Date() }],
          $position: 0,
          $slice: MAX_DEVICES_PER_USER,
        },
      },
      // Legacy single-token field is superseded; clear it once migrated.
      ...(user.fcmToken ? { $set: { fcmToken: '' } } : {}),
    }
  );

  return NextResponse.json({ success: true });
});

// DELETE /api/push/token — stop push on this device only
export const DELETE = withAuth(async (req: NextRequest, _ctx, { user }) => {
  const parsed = TokenSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 400 });
  }

  await connectDB();
  const { token } = parsed.data;
  await UserModel.updateOne(
    { _id: user._id },
    {
      $pull: { fcmTokens: { token } },
      ...(user.fcmToken === token ? { $set: { fcmToken: '' } } : {}),
    }
  );

  return NextResponse.json({ success: true });
});

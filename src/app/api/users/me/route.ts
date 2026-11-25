import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import UserModel from '@/models/User';
import { withAuth } from '@/lib/auth';

export const GET = withAuth(async (_req: NextRequest, _ctx, { user }) => {
  return NextResponse.json({
    success: true,
    data: {
      role: user.role,
      department: user.department,
    },
  });
});

// PATCH /api/users/me — legacy FCM token endpoint.
// Older cached clients still call this; tokens now live in `fcmTokens` and are
// managed by /api/push/token. A non-empty token is registered as a device;
// an empty value is ignored so one device can't wipe every other device.
export const PATCH = withAuth(async (req: NextRequest, _ctx, { user }) => {
  const body = await req.json().catch(() => ({}));

  if (typeof body.fcmToken === 'string' && body.fcmToken.length >= 20) {
    await connectDB();
    const token = body.fcmToken;
    await UserModel.updateOne({ _id: user._id }, { $pull: { fcmTokens: { token } } });
    await UserModel.updateOne(
      { _id: user._id },
      {
        $push: {
          fcmTokens: { $each: [{ token, lastSeenAt: new Date() }], $position: 0, $slice: 10 },
        },
      }
    );
  }

  return NextResponse.json({ success: true });
});

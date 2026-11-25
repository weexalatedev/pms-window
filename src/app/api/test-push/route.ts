import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/db';
import UserModel from '@/models/User';
import { sendFcmPushToUsers, isFcmConfigured } from '@/lib/firebase-admin';
import { withAuth } from '@/lib/auth';
import { pruneInvalidTokens } from '@/lib/notifications';
import { UserRole } from '@/types';

// POST /api/test-push - Send a test push notification to all active users
export const POST = withAuth(async (req: NextRequest, _ctx, { user }) => {
  if (user.role !== UserRole.ADMIN && user.role !== UserRole.SUPER_ADMIN) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }

  try {
    await connectDB();

    // Push delivery requires Firebase Admin credentials on the server.
    // Without them, sending is skipped and every token "fails" — surface a
    // clear configuration error instead of a misleading send failure.
    if (!isFcmConfigured()) {
      console.error(
        '[Test Push] Firebase Admin not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.'
      );
      return NextResponse.json(
        {
          success: false,
          error:
            'Push notifications are disabled: Firebase Admin credentials are not configured on the server (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY).',
        },
        { status: 503 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const title = body.title || '🔔 Test Notification';
    const bodyText = body.body || 'Push notifications are working. This is a test from Unique Arts PMS.';
    const link = body.link || '/dashboard';
    const onlyMe = body.onlyMe === true;

    // Fetch target users' device tokens. `onlyMe` avoids spamming the team
    // while testing a device.
    const hasToken = { $or: [{ 'fcmTokens.0': { $exists: true } }, { fcmToken: { $nin: ['', null] } }] };
    const users = await UserModel.find(onlyMe ? { _id: user._id, ...hasToken } : { isActive: true, ...hasToken })
      .select('fcmToken fcmTokens.token')
      .lean();

    const tokens = users.flatMap((u) =>
      [...(u.fcmTokens || []).map((t) => t.token), u.fcmToken || ''].filter(Boolean)
    );

    if (tokens.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: onlyMe
            ? 'No push token is registered for your account on this device. Open the notification bell and click "Enable" first.'
            : 'No users with registered FCM tokens found',
        },
        { status: 400 }
      );
    }

    const result = await sendFcmPushToUsers(tokens, title, bodyText, link, {
      type: 'test',
      source: 'test-push',
    });
    await pruneInvalidTokens(result.invalidTokens);

    if (result.failed > 0 && result.success === 0) {
      return NextResponse.json(
        { success: false, error: 'Failed to send push notification via FCM' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        notificationTitle: title,
        notificationBody: bodyText,
        onlyMe,
        totalUsers: users.length,
        devices: tokens.length,
        sent: result.success,
        failed: result.failed,
        message: `Test push delivered to ${result.success}/${tokens.length} devices (${users.length} users)`,
      },
    });
  } catch (error) {
    console.error('[Test Push] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
});
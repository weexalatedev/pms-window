import { NextRequest, NextResponse } from 'next/server';
import { runPendingTaskDigest } from '@/lib/notification-jobs';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/cron/notifications — daily pending/overdue task digest.
 *
 * Called by Vercel Cron (see vercel.json). Vercel sends
 * `Authorization: Bearer $CRON_SECRET`; requests without it are rejected, so
 * set CRON_SECRET in the Vercel project env vars.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ success: false, error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // defer: false — finish all deliveries before the cron invocation ends.
    const result = await runPendingTaskDigest({ defer: false });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('[cron/notifications] Digest failed:', error);
    return NextResponse.json({ success: false, error: 'Digest failed' }, { status: 500 });
  }
}

import { Suspense } from 'react';
import { getCurrentUser } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { AppLayout } from '@/components/layout/AppLayout';
import { DiscussionsClient } from './DiscussionsClient';

export const dynamic = 'force-dynamic';

export default async function DiscussionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  // Pass only the fields the client needs. `user` is a hydrated Mongoose
  // document (its push-token subdocuments point back at the parent), so it
  // can't be walked generically — and device tokens must not reach the browser.
  const currentUser = {
    _id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    department: user.department,
    avatar: user.avatar,
  };

  return (
    <AppLayout>
      <Suspense fallback={null}>
        <DiscussionsClient currentUser={currentUser} />
      </Suspense>
    </AppLayout>
  );
}

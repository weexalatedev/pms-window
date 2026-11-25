import mongoose from 'mongoose';
import { unstable_cache, revalidateTag } from 'next/cache';
import connectDB from '@/lib/db';
import ProjectModel from '@/models/Project';
import { ProjectStatus } from '@/types';

/**
 * Archive rule: a project with status `completed` is considered archived.
 * Its tasks must not appear in live task list views — they remain reachable
 * via Previous Work (/projects?tab=previous) and the project's own detail page.
 */

export const ARCHIVED_PROJECTS_TAG = 'archived-project-ids';

async function loadArchivedProjectIds(): Promise<string[]> {
  await connectDB();
  const docs = await ProjectModel.find({ status: ProjectStatus.COMPLETED })
    .select('_id')
    .lean();
  return docs.map((d) => d._id.toString());
}

/**
 * Completed-project IDs, cached in the Next.js data cache.
 *
 * Nearly every task list, the sidebar counts (polled every 30s per user) and
 * the dashboard need this list, but it only changes when a project is
 * completed/reopened/deleted. Those writes call `invalidateArchivedProjects()`;
 * the 5-minute revalidate is only a safety net.
 */
const getArchivedProjectIdsCached = unstable_cache(loadArchivedProjectIds, [ARCHIVED_PROJECTS_TAG], {
  tags: [ARCHIVED_PROJECTS_TAG],
  revalidate: 300,
});

export async function getArchivedProjectIds(): Promise<string[]> {
  try {
    return await getArchivedProjectIdsCached();
  } catch {
    // No Next.js cache available (scripts/tests) — query directly.
    return loadArchivedProjectIds();
  }
}

/** Call after any write that can change which projects are completed. */
export function invalidateArchivedProjects(): void {
  try {
    revalidateTag(ARCHIVED_PROJECTS_TAG, { expire: 0 });
  } catch {
    // Outside a request scope (scripts) there is no cache to clear.
  }
}

/**
 * `$match` stage that keeps internal tasks and tasks of live projects.
 * Replaces a per-document `$lookup` into projects, which forced a join for
 * every task on every dashboard load.
 */
export function liveTasksMatchStage(archivedIds: string[]): mongoose.PipelineStage.Match {
  if (archivedIds.length === 0) return { $match: {} };
  return {
    $match: {
      $or: [
        { projectId: null },
        { projectId: { $nin: archivedIds.map((id) => new mongoose.Types.ObjectId(id)) } },
      ],
    },
  };
}

/**
 * Mutates a Mongoose/Mongo task `query` object so tasks belonging to
 * archived (completed) projects are excluded. Internal tasks
 * (`projectId: null`) are always kept.
 *
 * Pass `skip=true` when the caller explicitly targets one project
 * (project detail view) — archived projects must still show their tasks.
 */
export function applyLiveProjectFilter(
  query: Record<string, unknown>,
  archivedIds: string[],
  opts: { skip?: boolean } = {},
): void {
  if (opts.skip) return;
  // Explicit single-project view (incl. archived project detail) — no filtering.
  if (query.projectId && typeof query.projectId === 'string') return;
  if (archivedIds.length === 0) return;
  const and = (query.$and as unknown[] | undefined) ?? [];
  and.push({
    $or: [{ projectId: null }, { projectId: { $nin: archivedIds } }],
  });
  query.$and = and;
}

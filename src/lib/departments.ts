import { unstable_cache, revalidateTag } from 'next/cache';
import connectDB from '@/lib/db';
import DepartmentModel from '@/models/Department';
import { DEPARTMENT_LABELS, DEPARTMENT_SEQUENCE } from '@/types';
import type { Department } from '@/types';

export interface DepartmentOption {
  name: Department;
  label: string;
  abbreviation: string;
  sequence: number;
  isActive: boolean;
}

export const DEPARTMENTS_TAG = 'departments';

/**
 * Active departments, cached in the Next.js data cache. They are read on most
 * page loads (task lists, workflow generation) but only change from the
 * Settings page, which calls `invalidateDepartments()`.
 */
export async function getActiveDepartmentOptions(): Promise<DepartmentOption[]> {
  try {
    return await getActiveDepartmentOptionsCached();
  } catch {
    // No Next.js cache available (scripts) — query directly.
    return loadActiveDepartmentOptions();
  }
}

/** Call after creating, editing, reordering or deleting a department. */
export function invalidateDepartments(): void {
  try {
    revalidateTag(DEPARTMENTS_TAG, { expire: 0 });
  } catch {
    // Outside a request scope there is no cache to clear.
  }
}

async function loadActiveDepartmentOptions(): Promise<DepartmentOption[]> {
  await connectDB();
  const departments = await DepartmentModel.find({ isActive: true })
    .select('name label abbreviation sequence isActive')
    .sort({ sequence: 1, label: 1 })
    .lean();

  if (departments.length > 0) {
    return departments.map((department) => ({
      name: department.name as Department,
      label: department.label,
      abbreviation: department.abbreviation,
      sequence: department.sequence,
      isActive: department.isActive,
    }));
  }

  return DEPARTMENT_SEQUENCE.map((name, sequence) => ({
    name,
    label: DEPARTMENT_LABELS[name] || formatDepartmentName(name),
    abbreviation: formatDepartmentAbbreviation(name),
    sequence,
    isActive: true,
  }));
}

const getActiveDepartmentOptionsCached = unstable_cache(loadActiveDepartmentOptions, [DEPARTMENTS_TAG], {
  tags: [DEPARTMENTS_TAG],
  revalidate: 3600,
});

export async function getActiveDepartmentNames(): Promise<Department[]> {
  return (await getActiveDepartmentOptions()).map((department) => department.name);
}

export function formatDepartmentName(department: string) {
  return DEPARTMENT_LABELS[department] || department.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatDepartmentAbbreviation(department: string) {
  return department
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase())
    .join('')
    .slice(0, 6) || department.slice(0, 3).toUpperCase();
}

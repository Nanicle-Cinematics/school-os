"use server";

import { requirePlatformAdmin } from "@/lib/platform-auth";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { writeAudit } from "@/lib/audit";

export type BackupState = { error?: string; ok?: string };

const REPO = "Nanicle-Cinematics/school-os";
const WORKFLOW = "school-backup.yml";
const RUNS_URL = `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`;

/**
 * Trigger the same GitHub Actions job the nightly per-school backup runs —
 * not a second implementation. Vercel's Node runtime has no pg_dump, so this
 * is a dispatch-and-link rather than a build-the-file-here-and-download
 * button: one real backup format (a genuine pg_dump, restorable per
 * RESTORING.md), not a JSON bundle with its own restore path to maintain.
 */
async function dispatch(school: string | null): Promise<BackupState> {
  const token = process.env.GITHUB_BACKUP_PAT;
  if (!token) {
    return {
      error:
        "GITHUB_BACKUP_PAT is not set in Vercel, so this console cannot reach GitHub. " +
        "A fine-grained PAT for this repo (actions:write, actions:read) needs adding first.",
    };
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: school ? { school } : {} }),
  });

  if (!res.ok) {
    // GitHub's own words, not a generic failure — a bad token and a bad
    // workflow name fail identically otherwise, and only one of them is
    // this console's fault to fix.
    const text = await res.text();
    return { error: `GitHub refused the request (${res.status}): ${text.slice(0, 200)}` };
  }

  return { ok: "Triggered — the run should appear on GitHub within a few seconds." };
}

/** So the GUI's "view on GitHub" link can never drift from where dispatch() posts to. */
export const SCHOOL_BACKUP_RUNS_URL = RUNS_URL;

export async function triggerSchoolBackup(
  _prev: BackupState,
  formData: FormData,
): Promise<BackupState> {
  const admin = await requirePlatformAdmin();
  const schoolId = String(formData.get("schoolId") ?? "");

  const school = await withBypass(() =>
    prisma.school.findUnique({ where: { id: schoolId }, select: { id: true, slug: true } }),
  );
  if (!school) {
    return { error: "That school no longer exists." };
  }

  const result = await dispatch(school.slug);
  if (result.error) {
    return result;
  }

  await withBypass(() =>
    writeAudit(prisma, {
      schoolId: school.id,
      actorUserId: admin.userId,
      action: "school.backup.triggered",
      entity: "School",
      entityId: school.id,
    }),
  );

  return result;
}

/**
 * No writeAudit here on purpose: this isn't scoped to one school, and
 * AuditEntry.schoolId is required — an entry attributed to no school in
 * particular is worse than none. The dispatched GitHub Actions run is
 * itself the record of who triggered it and when.
 */
export async function triggerAllSchoolsBackup(
  // useActionState requires both; nothing here is scoped to a school, so
  // neither is read.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: BackupState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<BackupState> {
  await requirePlatformAdmin();
  return dispatch(null);
}

import "server-only";

import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";

/**
 * Which school this session is in, from the cookie alone.
 *
 * Deliberately NOT `requireAuth`: that resolves the whole user, their
 * memberships, the school row and the staff record, which is a heavy join to
 * repeat for a request that needs one thing — which school is this session in.
 * Extracted from `/api/school-asset/[kind]` so the manifest and icon routes
 * that came after it read the session the same way rather than growing their
 * own copy.
 */
const COOKIE_NAME = "school_os_session";

export async function activeSchoolId(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  // Sign-in happens before a tenant is known, so this read bypasses RLS.
  const session = await withBypass(() =>
    prisma.session.findUnique({
      where: { tokenHash: createHash("sha256").update(token).digest("hex") },
      select: {
        expiresAt: true,
        activeSchoolId: true,
        user: {
          select: {
            deletedAt: true,
            memberships: {
              where: { status: "ACTIVE" },
              select: { schoolId: true },
            },
          },
        },
      },
    }),
  );

  if (!session || session.expiresAt < new Date() || session.user.deletedAt) {
    return null;
  }

  const memberships = session.user.memberships;
  if (memberships.length === 0) {
    return null;
  }
  return (
    memberships.find((m) => m.schoolId === session.activeSchoolId)?.schoolId ?? memberships[0].schoolId
  );
}

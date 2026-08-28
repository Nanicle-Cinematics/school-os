import "server-only";

import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { getSessionUser } from "@/lib/session";
import { setTenantContext } from "@/lib/tenant-context";
import { canAccess, landingFor } from "@/lib/permissions";

export type AuthContext = {
  userId: string;
  name: string;
  email: string | null;
  schoolId: string;
  schoolName: string;
  schoolShortName: string | null;
  schoolMotto: string | null;
  roles: Role[];
  staffId: string | null;
  isPlatformAdmin: boolean;
};

/**
 * The single gate every tenant-scoped page and server action goes through.
 *
 * Resolves the session, picks the active school, and — critically — installs the
 * tenant context BEFORE any tenant data is read, so `src/lib/prisma.ts` can set
 * the `app.school_id` GUC on every subsequent query.
 *
 * Redirects rather than throwing, so pages can call it as their first line.
 */
export async function requireAuth(): Promise<AuthContext> {
  const result = await getSessionUser();
  if (!result) {
    redirect("/login");
  }

  const { session, user } = result;

  // Prefer the school the session is pinned to; fall back to the user's first
  // active membership. A parent with children in two schools will later get a
  // switcher that rewrites session.activeSchoolId.
  const memberships = user.memberships;
  if (memberships.length === 0) {
    redirect("/no-access");
  }

  const active =
    memberships.find((m) => m.schoolId === session.activeSchoolId) ?? memberships[0];

  setTenantContext({ schoolId: active.schoolId });

  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    schoolId: active.schoolId,
    schoolName: active.school.name,
    schoolShortName: active.school.shortName,
    schoolMotto: active.school.motto,
    roles: memberships.filter((m) => m.schoolId === active.schoolId).map((m) => m.role),
    staffId: active.staffId,
    isPlatformAdmin: user.isPlatformAdmin,
  };
}

/** requireAuth plus a role check. Use on pages that only some roles may open. */
export async function requireRole(allowed: Role[]): Promise<AuthContext> {
  const auth = await requireAuth();
  if (!canAccess(auth.roles, allowed)) {
    // Not /dashboard: a teacher cannot open that either, and the two refusals
    // would redirect into each other.
    redirect(landingFor(auth.roles));
  }
  return auth;
}

/** For pages that must NOT be seen when signed in, e.g. /login. */
export async function redirectIfAuthenticated() {
  const result = await getSessionUser();
  if (result && result.user.memberships.length > 0) {
    const active = result.user.memberships[0];
    const roles = result.user.memberships
      .filter((m) => m.schoolId === active.schoolId)
      .map((m) => m.role);
    redirect(landingFor(roles));
  }
}

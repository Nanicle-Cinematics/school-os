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
  schoolCrestUrl: string | null;
  headSignatureUrl: string | null;
  headName: string | null;
  roles: Role[];
  staffId: string | null;
  /** The Guardian this login represents, for a parent. Null for staff. */
  guardianId: string | null;
  /** Still holding the temporary password the office issued. */
  mustChangePassword: boolean;
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

  // One user can hold SEVERAL memberships in the same school — the unique key is
  // (school, user, role) — and `active` is only the first of them. The person
  // record therefore has to be gathered across all of this school's memberships,
  // not read off that one row: a proprietor whose own child attends holds both
  // OWNER (staffId set, guardianId null) and PARENT (the reverse), and whichever
  // happened to sort first would otherwise decide what the app thinks they are.
  const here = memberships.filter((m) => m.schoolId === active.schoolId);
  const staffId = here.find((m) => m.staffId)?.staffId ?? null;
  const guardianId = here.find((m) => m.guardianId)?.guardianId ?? null;

  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    schoolId: active.schoolId,
    schoolName: active.school.name,
    schoolShortName: active.school.shortName,
    schoolMotto: active.school.motto,
    schoolCrestUrl: active.school.crestUrl,
    headSignatureUrl: active.school.headSignatureUrl,
    headName: active.school.headName,
    roles: here.map((m) => m.role),
    staffId,
    // Scalar on Membership, so this needs no extra include in getSessionUser.
    // It is the ONLY trustworthy source of "which family is this" — never take
    // a guardian id from a URL or a form field.
    guardianId,
    // Already loaded — getSessionUser includes every user scalar — so the
    // layouts can divert a temporary password without a second round trip,
    // which on this link would cost seconds on every page.
    mustChangePassword: user.mustChangePassword,
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

import "server-only";

import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAuth, type AuthContext } from "@/lib/auth";
import { landingFor } from "@/lib/permissions";

/**
 * The parent portal's row security.
 *
 * Postgres RLS scopes every query to the SCHOOL. It does not — and cannot —
 * scope to a family: two parents at the same school are the same tenant, so the
 * policies are satisfied by another family's child just as readily as by their
 * own. Family isolation is therefore the application's job, and this module is
 * the only place it is decided.
 *
 * The rule every portal query follows: the set of students is derived from the
 * session's guardian id, never from anything the browser sent. A student id in
 * the URL is checked against that set (`requireMyChild`) rather than trusted.
 *
 * `npm run verify:parent` asks for another family's child by URL and asserts a
 * refusal, because a route guard that merely hides a link is not a guard — the
 * same lesson `/students` taught with teachers.
 */

export type GuardianContext = AuthContext & {
  guardianId: string;
  /** Every student this guardian is linked to, whatever their status. */
  studentIds: string[];
};

/**
 * A signed-in guardian, with the children they are allowed to see.
 *
 * Redirects rather than throwing, so a page can call it as its first line. A
 * login with the PARENT role but no linked Guardian record is a provisioning
 * mistake, not an attack: it lands on /no-access rather than an empty portal
 * that would look like the school had lost their children.
 */
export async function requireGuardian(): Promise<GuardianContext> {
  const auth = await requireAuth();

  if (!auth.guardianId) {
    // Staff who wandered in, or a PARENT membership with no guardian linked.
    // landingFor keeps this from bouncing between two refusals.
    redirect(auth.roles.includes("PARENT") ? "/no-access" : landingFor(auth.roles));
  }

  const links = await prisma.studentGuardian.findMany({
    where: { guardianId: auth.guardianId, student: { deletedAt: null } },
    select: { studentId: true },
  });

  return { ...auth, guardianId: auth.guardianId, studentIds: links.map((l) => l.studentId) };
}

/**
 * Confirm a student id from the URL belongs to this guardian.
 *
 * 404 rather than 403 deliberately: a parent who can distinguish "not yours"
 * from "does not exist" can enumerate the school's roll one id at a time.
 */
export async function requireMyChild(studentId: string): Promise<GuardianContext> {
  const ctx = await requireGuardian();
  if (!ctx.studentIds.includes(studentId)) {
    notFound();
  }
  return ctx;
}

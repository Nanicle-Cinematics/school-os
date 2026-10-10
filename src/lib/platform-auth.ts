import "server-only";

import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { landingFor } from "@/lib/permissions";

export type PlatformContext = {
  userId: string;
  name: string;
  email: string | null;
};

/**
 * The signed-in platform admin, with NO other condition. Only the page that
 * replaces a temporary password (and its action) use this, because they are where
 * the divert below ends: sending a flagged admin to a page that sent them back
 * would loop.
 */
export async function requirePlatformAdminUser() {
  const result = await getSessionUser();
  if (!result) {
    redirect("/login");
  }

  const { user, session } = result;
  if (!user.isPlatformAdmin) {
    // Same destination as an ordinary signed-in user hitting a page they may
    // not see: no hint that this URL is worth probing.
    const active = user.memberships[0];
    redirect(
      landingFor(
        active
          ? user.memberships.filter((m) => m.schoolId === active.schoolId).map((m) => m.role)
          : [],
      ),
    );
  }

  return { user, session };
}

/**
 * A platform admin's session, BEFORE the second factor has been checked.
 *
 * Only the two pages that deal with the second factor (/admin/security and
 * /admin/verify) use this; everything else goes through `requirePlatformAdmin`.
 *
 * ⚠️ A login still on its TEMPORARY password is sent to choose its own first.
 * `make:admin` prints that password to a terminal and promises it "must be changed
 * at the first sign-in", but the divert that keeps that promise lives in the
 * (app) and (portal) layouts, and /admin is in neither: a flagged admin went
 * straight on to enrol an authenticator, and the temporary password stayed in
 * force. `/account/password` cannot serve them either, because it needs a school
 * and a platform admin belongs to none — hence a page of their own.
 */
export async function requirePlatformAdminSession() {
  const found = await requirePlatformAdminUser();
  if (found.user.mustChangePassword) {
    redirect("/admin/password");
  }
  return found;
}

/**
 * The gate for the Nanicle console, which sits outside every tenant.
 *
 * Deliberately NOT requireAuth: that resolves a school and bounces anyone
 * without a membership to /no-access, and a platform admin legitimately belongs
 * to no school. It also never calls setTenantContext — the console reads and
 * writes across tenants, so pinning it to one would be wrong.
 *
 * ⚠️ One password was all that stood between the internet and every school's
 * records, subscriptions and backups. So the console also needs a second factor,
 * and BOTH halves are enforced here, on every page and every server action:
 *
 *   - an admin who has not enrolled is sent to enrol — the console is closed to
 *     them until they do, so "optional" cannot quietly mean "off";
 *   - an enrolled admin's session must have passed the code check
 *     (`session.mfaVerifiedAt`), so a stolen password or a stolen cookie issued
 *     before the code was entered opens nothing.
 */
export async function requirePlatformAdmin(): Promise<PlatformContext> {
  const { user, session } = await requirePlatformAdminSession();

  if (!user.totpEnabledAt) {
    redirect("/admin/security");
  }
  if (!session.mfaVerifiedAt) {
    redirect("/admin/verify");
  }

  return { userId: user.id, name: user.name, email: user.email };
}

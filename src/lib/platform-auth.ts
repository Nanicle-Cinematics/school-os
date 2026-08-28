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
 * The gate for the Nanicle console, which sits outside every tenant.
 *
 * Deliberately NOT requireAuth: that resolves a school and bounces anyone
 * without a membership to /no-access, and a platform admin legitimately belongs
 * to no school. It also never calls setTenantContext — the console reads and
 * writes across tenants, so pinning it to one would be wrong.
 */
export async function requirePlatformAdmin(): Promise<PlatformContext> {
  const result = await getSessionUser();
  if (!result) {
    redirect("/login");
  }

  const { user } = result;
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

  return { userId: user.id, name: user.name, email: user.email };
}

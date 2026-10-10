"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { requirePlatformAdminUser } from "@/lib/platform-auth";
import { hashPassword, verifyPassword } from "@/lib/password";
import { takeAttempt } from "@/lib/rate-limit";

export type PlatformPasswordState = { error?: string };

const MIN_LENGTH = 8;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * Choose your own password, as a platform admin.
 *
 * The school-side `changePassword` cannot serve this account: it resolves a school
 * through `requireAuth`, and a platform admin belongs to none, so it sends them to
 * /no-access. Same rules otherwise — the CURRENT password is required (a session
 * left open must not be enough), and every OTHER session is signed out on success,
 * so a password changed because it leaked ends the leak.
 *
 * Uses `requirePlatformAdminUser`, not the session gate: the session gate diverts a
 * flagged account to the page this action belongs to, and gating the action on it
 * would make the change impossible. The current-password guesses share the small
 * allowance the second factor uses, since this is the same account.
 */
export async function changePlatformPassword(
  _prev: PlatformPasswordState,
  formData: FormData,
): Promise<PlatformPasswordState> {
  const { user, session } = await requirePlatformAdminUser();

  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!current || !next || !confirm) {
    return { error: "Fill in your current password and the new one twice." };
  }
  if (next !== confirm) {
    return { error: "The two new passwords do not match." };
  }
  if (next.length < MIN_LENGTH) {
    return { error: `A password needs at least ${MIN_LENGTH} characters.` };
  }
  if (next === current) {
    return { error: "The new password must be different from the current one." };
  }

  if (!(await takeAttempt(`pw:${user.id}`, 8, FIFTEEN_MINUTES))) {
    return { error: "Too many attempts. Wait 15 minutes and try again." };
  }
  if (!user.passwordHash || !(await verifyPassword(current, user.passwordHash))) {
    return { error: "That is not your current password." };
  }

  const passwordHash = await hashPassword(next);
  await withBypass(async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordIssuedAt: null,
        passwordChangedAt: new Date(),
      },
    });
    await prisma.session.deleteMany({ where: { userId: user.id, id: { not: session.id } } });
  });

  redirect("/admin");
}

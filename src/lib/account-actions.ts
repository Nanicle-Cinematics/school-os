"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requireAuthEvenIfTemporary as requireAuth } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { hashToken } from "@/lib/session";
import { hashPassword, verifyPassword } from "@/lib/password";
import { writeAudit } from "@/lib/audit";
import { landingFor } from "@/lib/permissions";

export type PasswordState = { error?: string };

const MIN_LENGTH = 8;
const SESSION_COOKIE = "school_os_session";

/**
 * Change your own password.
 *
 * This exists because the app had no way to do it at all. Every account — staff
 * and parent alike — was created with a TEMPORARY password read aloud by the
 * office, and that password stayed valid forever unless an admin reset it to
 * another temporary one. The guardian-login screen even told the office to "ask
 * them to change it", which was not something the software could do.
 *
 * Requires the CURRENT password: a session left open on a shared phone must not
 * be enough to take the account over. Every OTHER session is signed out on
 * success, so a password changed because it leaked actually ends the leak.
 */
export async function changePassword(
  _prev: PasswordState,
  formData: FormData,
): Promise<PasswordState> {
  const auth = await requireAuth();
  // readOnly: false, deliberately. An expired trial or unpaid school may not
  // write school records, but a person must still be able to change their OWN
  // password — and a temporary-password login is refused everywhere else until
  // they do, so blocking this here locked them out of a school they could
  // otherwise still read.
  setTenantContext({ schoolId: auth.schoolId, readOnly: false });

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

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { passwordHash: true },
  });
  if (!user?.passwordHash || !(await verifyPassword(current, user.passwordHash))) {
    return { error: "That is not your current password." };
  }

  const passwordHash = await hashPassword(next);

  // Keep THIS session; end the others. Matching on the hash rather than an id
  // because that is what the cookie carries — see createSession.
  const raw = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const keep = raw ? hashToken(raw) : "";

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.user.update({
      where: { id: auth.userId },
      data: { passwordHash, mustChangePassword: false,
        passwordIssuedAt: null,
        passwordChangedAt: new Date(),
      },
    });
    await tx.session.deleteMany({
      where: { userId: auth.userId, ...(keep ? { tokenHash: { not: keep } } : {}) },
    });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "user.password.change",
      entity: "User",
      entityId: auth.userId,
    });
  });

  redirect(landingFor(auth.roles));
}

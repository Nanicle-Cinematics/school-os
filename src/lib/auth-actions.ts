"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { landingFor } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { normalisePhone } from "@/lib/sms-shared";
import { verifyPassword } from "@/lib/password";
import { createSession, destroySession } from "@/lib/session";

export type LoginState = { error?: string };

/** Wrong passwords before the identifier is locked out. */
const MAX_LOGIN_ATTEMPTS = 8;
/** How long a lockout lasts once triggered. */
const LOCKOUT_MINUTES = 15;

async function recordFailedAttempt(identifier: string) {
  const attempt = await withBypass(() =>
    prisma.loginAttempt.upsert({
      where: { identifier },
      create: { identifier, attempts: 1 },
      update: { attempts: { increment: 1 } },
    }),
  );
  if (attempt.attempts >= MAX_LOGIN_ATTEMPTS) {
    await withBypass(() =>
      prisma.loginAttempt.update({
        where: { identifier },
        data: { lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) },
      }),
    );
  }
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const identifier = String(formData.get("identifier") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!identifier || !password) {
    return { error: "Enter your email or phone number and your password." };
  }

  const locked = await withBypass(() =>
    prisma.loginAttempt.findUnique({ where: { identifier } }),
  );
  if (locked?.lockedUntil && locked.lockedUntil > new Date()) {
    return { error: `Too many attempts. Try again in ${LOCKOUT_MINUTES} minutes.` };
  }

  // Sign in by email or phone — many parents and staff have no email address.
  //
  // The phone is matched BOTH as typed and normalised. normalisePhone stores
  // 0540000035 as 233540000035, so matching only the raw string meant a parent
  // typing their number the way every Ghanaian knows it was told "incorrect
  // email/phone or password" — indistinguishable from a wrong password, and
  // with no way for them to guess the stored form.
  const asPhone = normalisePhone(identifier);
  const user = await withBypass(() =>
    prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { email: identifier },
          { phone: identifier },
          ...(asPhone && asPhone !== identifier ? [{ phone: asPhone }] : []),
        ],
      },
      include: { memberships: { where: { status: "ACTIVE" } } },
    }),
  );

  // Deliberately identical message for unknown user and wrong password, so the
  // form cannot be used to enumerate who has an account.
  const invalid = { error: "Incorrect email/phone or password." };

  if (!user?.passwordHash) {
    await recordFailedAttempt(identifier);
    return invalid;
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    // Count the miss BEFORE answering, same discipline as the password-reset
    // code: a typo and a brute force are told apart by the counter, not by how
    // fast either one gets a response.
    await recordFailedAttempt(identifier);
    return invalid;
  }
  // A correct password clears any lockout building up against this identifier.
  await withBypass(() => prisma.loginAttempt.deleteMany({ where: { identifier } }));

  // A platform admin deliberately belongs to no school — the Nanicle console
  // sits outside every tenant. Requiring a membership here locked the only
  // account that can provision the first school out of the product entirely.
  if (user.memberships.length === 0 && !user.isPlatformAdmin) {
    return { error: "This account is not linked to any school. Contact your administrator." };
  }

  const headerList = await headers();
  await createSession(user.id, {
    activeSchoolId: user.memberships[0]?.schoolId,
    ip: headerList.get("x-forwarded-for")?.split(",")[0]?.trim(),
    userAgent: headerList.get("user-agent") ?? undefined,
  });

  await withBypass(() =>
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
  );

  // Someone with no membership has nowhere to go inside a school.
  if (user.memberships.length === 0) {
    redirect("/admin");
  }
  const active = user.memberships[0];
  redirect(
    landingFor(
      user.memberships.filter((m) => m.schoolId === active.schoolId).map((m) => m.role),
    ),
  );
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

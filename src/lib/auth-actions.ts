"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { landingFor } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { normalisePhone } from "@/lib/sms-shared";
import { hashPassword, verifyPassword } from "@/lib/password";
import { createSession, destroySession } from "@/lib/session";

export type LoginState = { error?: string };

/** Wrong passwords before the identifier is locked out. */
const MAX_LOGIN_ATTEMPTS = 8;
/** How long a lockout lasts once triggered. */
const LOCKOUT_MINUTES = 15;

/**
 * A real scrypt hash to verify against when the identifier matches nobody, so an
 * unknown account costs the same time as a wrong password and the response time
 * does not say which accounts exist.
 */
const DUMMY_HASH = hashPassword("not-a-real-password");

/**
 * Count this attempt BEFORE the password is looked at, atomically.
 *
 * It used to read the counter, check the password, then increment on a miss —
 * so a burst of parallel guesses all read "not locked" and all got checked.
 * Incrementing first makes the database the arbiter: only the first
 * MAX_LOGIN_ATTEMPTS requests in a window ever reach verifyPassword, however
 * they are interleaved. A correct password clears the counter afterwards.
 */
async function claimAttempt(identifier: string): Promise<boolean> {
  const existing = await withBypass(() =>
    prisma.loginAttempt.findUnique({ where: { identifier } }),
  );
  if (existing?.lockedUntil) {
    if (existing.lockedUntil > new Date()) {
      return false;
    }
    // The lockout ran out: start a fresh count rather than re-locking on the
    // very next typo because the old total was still sitting there.
    await withBypass(() => prisma.loginAttempt.deleteMany({ where: { identifier } }));
  }

  const attempt = await withBypass(() =>
    prisma.loginAttempt.upsert({
      where: { identifier },
      create: { identifier, attempts: 1 },
      update: { attempts: { increment: 1 } },
    }),
  );
  if (attempt.attempts > MAX_LOGIN_ATTEMPTS) {
    await withBypass(() =>
      prisma.loginAttempt.update({
        where: { identifier },
        data: { lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) },
      }),
    );
    return false;
  }
  return true;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const identifier = String(formData.get("identifier") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!identifier || !password) {
    return { error: "Enter your email or phone number and your password." };
  }

  // One counter per PERSON, not per spelling: 0244…, 233244… and +233244… are the
  // same phone, and keying on what was typed gave an attacker a fresh allowance
  // for each format.
  const asPhone = normalisePhone(identifier);
  const lockKey = asPhone ?? identifier;

  if (!(await claimAttempt(lockKey))) {
    return { error: `Too many attempts. Try again in ${LOCKOUT_MINUTES} minutes.` };
  }

  // Sign in by email or phone — many parents and staff have no email address.
  //
  // The phone is matched BOTH as typed and normalised. normalisePhone stores
  // 0540000035 as 233540000035, so matching only the raw string meant a parent
  // typing their number the way every Ghanaian knows it was told "incorrect
  // email/phone or password" — indistinguishable from a wrong password, and
  // with no way for them to guess the stored form.
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
    await verifyPassword(password, await DUMMY_HASH);
    return invalid;
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    return invalid;
  }
  // A correct password clears the count building up against this identifier.
  await withBypass(() => prisma.loginAttempt.deleteMany({ where: { identifier: lockKey } }));

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

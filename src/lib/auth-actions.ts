"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { landingFor } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { normalisePhone } from "@/lib/sms-shared";
import { hashPassword, verifyPassword } from "@/lib/password";
import { clearAttempts, clientIp, takeAttempt } from "@/lib/rate-limit";
import { createSession, destroySession } from "@/lib/session";

export type LoginState = { error?: string };

/** Wrong passwords before the identifier is locked out. */
const MAX_LOGIN_ATTEMPTS = 8;
/** Days an unused temporary password keeps working. */
const TEMP_PASSWORD_DAYS = 14;
/** How long a bucket stays full once exhausted. */
const LOCKOUT_MINUTES = 15;

/**
 * A real scrypt hash to verify against when the identifier matches nobody, so an
 * unknown account costs the same time as a wrong password and the response time
 * does not say which accounts exist.
 */
const DUMMY_HASH = hashPassword("not-a-real-password");

/**
 * Three buckets, all claimed BEFORE the password is looked at, each atomically.
 *
 * Why three: one counter per account lets anyone who knows a phone number lock
 * its owner out for 15 minutes by guessing wrongly 8 times. So the tight limit
 * is per (account, address) — the attacker exhausts only THEIR own allowance —
 * and the per-account ceiling is set well above it, so it still stops a
 * distributed guesser without an easy way to lock a real person out. The
 * per-address bucket stops one machine spraying across many accounts.
 */
const PAIR_MAX = MAX_LOGIN_ATTEMPTS;
const ACCOUNT_MAX = 25;
const ADDRESS_MAX = 40;
const WINDOW_MS = LOCKOUT_MINUTES * 60 * 1000;

const keys = (account: string, ip: string) => ({
  pair: `login:${account}|${ip}`,
  account: `login-acct:${account}`,
  address: `login-ip:${ip}`,
});

async function claimAttempt(account: string, ip: string): Promise<boolean> {
  const k = keys(account, ip);
  // Every bucket is claimed (no short-circuit) so each keeps counting honestly.
  const results = await Promise.all([
    takeAttempt(k.pair, PAIR_MAX, WINDOW_MS),
    takeAttempt(k.account, ACCOUNT_MAX, WINDOW_MS),
    takeAttempt(k.address, ADDRESS_MAX, WINDOW_MS),
  ]);
  return results.every(Boolean);
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

  const ip = await clientIp();
  if (!(await claimAttempt(lockKey, ip))) {
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
  /**
   * A temporary password is good for 14 days, not for ever.
   *
   * The office reads it down a phone or texts it to a number nobody has verified,
   * and until now it stayed valid until first use — so one sent to the wrong
   * number, or never collected, was a standing way into a school. Checked AFTER
   * the password is proven right (so it tells nobody anything about a wrong
   * guess) and before a session exists. The office issues another from /users or
   * the guardian's page.
   */
  if (
    user.mustChangePassword &&
    user.passwordIssuedAt &&
    Date.now() - user.passwordIssuedAt.getTime() > TEMP_PASSWORD_DAYS * 24 * 60 * 60 * 1000
  ) {
    return {
      error:
        "That temporary password has expired. Ask the school office to issue you a new one.",
    };
  }

  // A correct password clears what this person's own typos built up. The shared
  // per-address bucket is left to expire: it is not theirs to reset.
  const k = keys(lockKey, ip);
  await clearAttempts(k.pair, k.account);

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

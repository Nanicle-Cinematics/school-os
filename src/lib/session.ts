import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { SESSION_COOKIE_NAME as COOKIE_NAME } from "@/lib/session-cookie";
import { evaluateSession, initialExpiry, policyFor, type SessionPolicy } from "@/lib/session-policy";

// Only the hash is stored. A leaked database row cannot be replayed as a
// session, and the raw token exists only in the user's cookie.
export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * `policy` is REQUIRED, with no default: what a session lasts depends on who it is for (see
 * session-policy.ts), and a default would quietly give a platform admin the staff rules.
 */
export async function createSession(
  userId: string,
  opts: { activeSchoolId?: string; ip?: string; userAgent?: string; policy: SessionPolicy },
) {
  const token = randomBytes(32).toString("hex");
  const createdAt = new Date();
  const expiresAt = initialExpiry(createdAt, opts.policy);

  // Housekeeping, and never allowed to fail a sign-in: this person's sessions that have already
  // ended. Nothing else deletes a session nobody visits again, so they only ever accumulated.
  try {
    await withBypass(() => prisma.session.deleteMany({ where: { userId, expiresAt: { lt: createdAt } } }));
  } catch {
    // Left for the next sign-in.
  }

  // Session writes happen before any tenant is resolved, so they must bypass RLS.
  await withBypass(() =>
    prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        activeSchoolId: opts.activeSchoolId,
        createdAt,
        expiresAt,
        ip: opts.ip,
        userAgent: opts.userAgent,
      },
    }),
  );

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    // Lax and not Strict, on purpose: a parent opens the portal from a link in a text message, and
    // Strict would drop the cookie on that cross-site navigation, so they would land signed out.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // The browser forgets it at the ABSOLUTE end. The idle deadline is the server's to enforce.
    expires: new Date(createdAt.getTime() + opts.policy.absoluteMs),
  });

  return { token, expiresAt };
}

export async function readSessionToken() {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value ?? null;
}

/**
 * Resolve the current session to its user and memberships. Returns null for a
 * missing, unknown or expired cookie. Runs with RLS bypassed — this is the call
 * that establishes which tenant we are in, so it cannot itself be tenant-scoped.
 */
export async function getSessionUser() {
  const token = await readSessionToken();
  if (!token) {
    return null;
  }

  const session = await withBypass(() =>
    prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        user: {
          include: {
            memberships: {
              where: { status: "ACTIVE" },
              include: { school: true, staff: true },
            },
          },
        },
      },
    }),
  );

  if (!session) {
    return null;
  }
  if (session.user.deletedAt) {
    return null;
  }

  // The same verdict `activeSchoolId` reaches from the same row: see evaluateSession.
  const policy = policyFor({
    isPlatformAdmin: session.user.isPlatformAdmin,
    roles: session.user.memberships.map((m) => m.role),
  });
  const verdict = evaluateSession(session, policy);
  if (!verdict.live) {
    // Past its idle or absolute end: remove the row, since nobody else will. Best-effort.
    await withBypass(() => prisma.session.deleteMany({ where: { id: session.id } })).catch(() => undefined);
    return null;
  }
  if (verdict.extendTo) {
    // Moves the idle deadline (and, for a session older than a rule, brings it under that rule).
    // Throttled inside evaluateSession to one write per EXTEND_AFTER_MS, and never allowed to fail
    // the request that triggered it: a missed extension just means the next one makes it.
    await withBypass(() =>
      prisma.session.update({ where: { id: session.id }, data: { expiresAt: verdict.extendTo! } }),
    ).catch(() => undefined);
  }

  return { session, user: session.user };
}

export async function destroySession() {
  const token = await readSessionToken();
  if (token) {
    await withBypass(() =>
      prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } }),
    );
  }
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function setActiveSchool(sessionId: string, schoolId: string) {
  await withBypass(() =>
    prisma.session.update({ where: { id: sessionId }, data: { activeSchoolId: schoolId } }),
  );
}

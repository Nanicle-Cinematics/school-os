import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";

const COOKIE_NAME = "school_os_session";
const SESSION_DAYS = 30;

// Only the hash is stored. A leaked database row cannot be replayed as a
// session, and the raw token exists only in the user's cookie.
function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
  opts: { activeSchoolId?: string; ip?: string; userAgent?: string } = {},
) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  // Session writes happen before any tenant is resolved, so they must bypass RLS.
  await withBypass(() =>
    prisma.session.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        activeSchoolId: opts.activeSchoolId,
        expiresAt,
        ip: opts.ip,
        userAgent: opts.userAgent,
      },
    }),
  );

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
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

  if (!session || session.expiresAt < new Date()) {
    return null;
  }
  if (session.user.deletedAt) {
    return null;
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

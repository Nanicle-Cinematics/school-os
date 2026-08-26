"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { verifyPassword } from "@/lib/password";
import { createSession, destroySession } from "@/lib/session";

export type LoginState = { error?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const identifier = String(formData.get("identifier") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!identifier || !password) {
    return { error: "Enter your email or phone number and your password." };
  }

  // Sign in by email or phone — many parents and staff have no email address.
  const user = await withBypass(() =>
    prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [{ email: identifier }, { phone: identifier }],
      },
      include: { memberships: { where: { status: "ACTIVE" } } },
    }),
  );

  // Deliberately identical message for unknown user and wrong password, so the
  // form cannot be used to enumerate who has an account.
  const invalid = { error: "Incorrect email/phone or password." };

  if (!user?.passwordHash) {
    return invalid;
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    return invalid;
  }
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
  redirect(user.memberships.length === 0 ? "/admin" : "/dashboard");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

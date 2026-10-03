"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { requirePlatformAdminSession } from "@/lib/platform-auth";
import { base32Encode, generateSecret, verifyTotp } from "@/lib/totp";
import { decryptSecret, encryptSecret, hashRecoveryCode } from "@/lib/totp-crypto";
import { clientIp, takeAttempt } from "@/lib/rate-limit";

export type TwoFactorState = { error?: string; recoveryCodes?: string[] };

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const RECOVERY_CODES = 10;

/**
 * Six digits can be guessed — a million of them — so every attempt, right or wrong,
 * counts against a small allowance per ACCOUNT and a larger one per ADDRESS. The
 * count is an atomic increment (see rate-limit.ts), so parallel guesses cannot
 * all slip under the limit.
 */
async function withinLimit(userId: string) {
  const ip = await clientIp();
  const [account, address] = await Promise.all([
    takeAttempt(`2fa:${userId}`, 8, FIFTEEN_MINUTES),
    takeAttempt(`2fa-ip:${ip}`, 30, FIFTEEN_MINUTES),
  ]);
  return account && address;
}

const TOO_MANY = "Too many attempts. Wait 15 minutes and try again.";
const WRONG = "That code is wrong or has expired. Check the time on your phone and try the newest code.";

/** Mark a step as spent. False if it was spent already — i.e. someone raced us with the same code. */
async function spendStep(userId: string, step: number) {
  const { count } = await withBypass(() =>
    prisma.user.updateMany({
      where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    }),
  );
  return count === 1;
}

function newRecoveryCodes() {
  // 10 base32 characters = 50 random bits each, written XXXXX-XXXXX.
  return Array.from({ length: RECOVERY_CODES }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

type SessionUser = Awaited<ReturnType<typeof requirePlatformAdminSession>>["user"];

/** Check a TOTP code for an enrolled admin and spend it. Returns an error message, or null on success. */
async function acceptTotp(user: SessionUser, rawCode: string): Promise<string | null> {
  if (!(await withinLimit(user.id))) {
    return TOO_MANY;
  }
  if (!user.totpSecretEnc) {
    return WRONG;
  }
  const step = verifyTotp(decryptSecret(user.totpSecretEnc), rawCode, Date.now(), user.totpLastStep);
  if (step === null || !(await spendStep(user.id, step))) {
    return WRONG;
  }
  return null;
}

/** Begin enrolment: make a secret, keep it (encrypted) as PENDING, and show it on the setup page. */
export async function startSetup(): Promise<void> {
  const { user } = await requirePlatformAdminSession();
  if (user.totpEnabledAt) {
    redirect("/admin/security");
  }
  await withBypass(() =>
    prisma.user.update({
      where: { id: user.id },
      data: { totpSecretEnc: encryptSecret(generateSecret()), totpLastStep: null },
    }),
  );
  redirect("/admin/security");
}

/** Confirm enrolment with a first code from the app. Shows the recovery codes ONCE. */
export async function confirmSetup(_prev: TwoFactorState, formData: FormData): Promise<TwoFactorState> {
  const { user, session } = await requirePlatformAdminSession();
  if (user.totpEnabledAt || !user.totpSecretEnc) {
    redirect("/admin/security");
  }
  if (!(await withinLimit(user.id))) {
    return { error: TOO_MANY };
  }

  const step = verifyTotp(
    decryptSecret(user.totpSecretEnc),
    String(formData.get("code") ?? ""),
    Date.now(),
    null,
  );
  if (step === null) {
    return { error: WRONG };
  }

  const codes = newRecoveryCodes();
  await withBypass(async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        totpEnabledAt: new Date(),
        totpLastStep: step,
        recoveryCodeHashes: codes.map(hashRecoveryCode),
      },
    });
    // The person who has just proved they hold the app does not have to prove it again.
    await prisma.session.update({ where: { id: session.id }, data: { mfaVerifiedAt: new Date() } });
  });

  return { recoveryCodes: codes };
}

/** Sign-in step two: a code from the app, or a one-time recovery code. */
export async function verifyLogin(_prev: TwoFactorState, formData: FormData): Promise<TwoFactorState> {
  const { user, session } = await requirePlatformAdminSession();
  if (!user.totpEnabledAt) {
    redirect("/admin/security");
  }

  const submitted = String(formData.get("code") ?? "").trim();
  const isTotp = /^\d{3}\s?\d{3}$/.test(submitted);

  if (isTotp) {
    const failure = await acceptTotp(user, submitted);
    if (failure) {
      return { error: failure };
    }
  } else {
    if (!(await withinLimit(user.id))) {
      return { error: TOO_MANY };
    }
    const hash = hashRecoveryCode(submitted);
    if (submitted.length < 8 || !user.recoveryCodeHashes.includes(hash)) {
      return { error: "That is not a valid code or recovery code." };
    }
    // Single use. The `has` in the WHERE means two requests with the same code cannot both win.
    const { count } = await withBypass(() =>
      prisma.user.updateMany({
        where: { id: user.id, recoveryCodeHashes: { has: hash } },
        data: { recoveryCodeHashes: { set: user.recoveryCodeHashes.filter((h) => h !== hash) } },
      }),
    );
    if (count !== 1) {
      return { error: "That recovery code has already been used." };
    }
  }

  await withBypass(() =>
    prisma.session.update({ where: { id: session.id }, data: { mfaVerifiedAt: new Date() } }),
  );
  redirect("/admin");
}

/** New recovery codes, replacing the old ones. Needs a current code from the app. */
export async function regenerateRecoveryCodes(_prev: TwoFactorState, formData: FormData): Promise<TwoFactorState> {
  const { user } = await requirePlatformAdminSession();
  if (!user.totpEnabledAt) {
    redirect("/admin/security");
  }
  const failure = await acceptTotp(user, String(formData.get("code") ?? ""));
  if (failure) {
    return { error: failure };
  }
  const codes = newRecoveryCodes();
  await withBypass(() =>
    prisma.user.update({ where: { id: user.id }, data: { recoveryCodeHashes: codes.map(hashRecoveryCode) } }),
  );
  return { recoveryCodes: codes };
}

/**
 * Throw the authenticator away and enrol a new one (a new phone). Needs a current
 * code, signs every OTHER session out, and sends this one back through enrolment.
 */
export async function replaceAuthenticator(_prev: TwoFactorState, formData: FormData): Promise<TwoFactorState> {
  const { user, session } = await requirePlatformAdminSession();
  if (!user.totpEnabledAt) {
    redirect("/admin/security");
  }
  const failure = await acceptTotp(user, String(formData.get("code") ?? ""));
  if (failure) {
    return { error: failure };
  }
  await withBypass(async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryCodeHashes: [] },
    });
    await prisma.session.deleteMany({ where: { userId: user.id, id: { not: session.id } } });
    await prisma.session.update({ where: { id: session.id }, data: { mfaVerifiedAt: null } });
  });
  redirect("/admin/security");
}

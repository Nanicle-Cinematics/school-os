import "server-only";

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";

/**
 * The caller's address, for rate limits only.
 *
 * Behind Vercel the platform sets `x-forwarded-for` itself, so the first hop is
 * the client's. Anywhere else it is client-controlled, which is why this feeds
 * limits that ADD a bucket (per address) rather than replace the per-account
 * one. Returns "unknown" when nothing is sent, which then shares one bucket.
 */
export async function clientIp(): Promise<string> {
  const list = await headers();
  return (
    list.get("x-real-ip")?.trim() ||
    list.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Count one attempt against `key` and say whether it may proceed — as ONE atomic
 * increment, so a burst of parallel requests cannot all read "under the limit".
 *
 * Fixed window measured from the bucket's last activity. Past `max` the bucket
 * answers false until it has been quiet for `windowMs`; blocked attempts count
 * too, so hammering it does not buy a fresh allowance. Backed by LoginAttempt,
 * which is just (key, count, updatedAt) — the keys are namespaced by the caller.
 */
export async function takeAttempt(key: string, max: number, windowMs: number): Promise<boolean> {
  const existing = await withBypass(() =>
    prisma.loginAttempt.findUnique({ where: { identifier: key } }),
  );
  if (existing && Date.now() - existing.updatedAt.getTime() > windowMs) {
    await withBypass(() => prisma.loginAttempt.deleteMany({ where: { identifier: key } }));
  }
  const row = await withBypass(() =>
    prisma.loginAttempt.upsert({
      where: { identifier: key },
      create: { identifier: key, attempts: 1 },
      update: { attempts: { increment: 1 } },
    }),
  );
  return row.attempts <= max;
}

export async function clearAttempts(...keys: string[]) {
  await withBypass(() => prisma.loginAttempt.deleteMany({ where: { identifier: { in: keys } } }));
}

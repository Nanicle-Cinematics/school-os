/**
 * Clear a platform admin's second factor, for the day the phone AND the recovery
 * codes are both gone (or TOTP_ENCRYPTION_KEY was lost, which makes every stored
 * secret unreadable).
 *
 * Like `make:admin`, this needs database access on purpose: there is no screen for it,
 * because a screen that can switch the second factor off is a way around it. The
 * admin signs in with their password, is sent to enrol again, and every existing
 * session is ended so nothing issued before the reset carries on.
 *
 *   node --env-file=.env.prod scripts/reset-platform-2fa.mjs someone@example.com
 */
import { PrismaClient } from "@prisma/client";

const email = process.argv.slice(2).find((arg) => !arg.startsWith("--"))?.trim().toLowerCase();
if (!email) {
  console.error("Usage: node --env-file=<env> scripts/reset-platform-2fa.mjs <email>");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const user = await prisma.user.findFirst({
  where: { email, deletedAt: null, isPlatformAdmin: true },
  select: { id: true, name: true, email: true, totpEnabledAt: true },
});
if (!user) {
  console.error(`No platform admin with the email ${email}.`);
  await prisma.$disconnect();
  process.exit(1);
}

await prisma.user.update({
  where: { id: user.id },
  data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryCodeHashes: [] },
});
const ended = await prisma.session.deleteMany({ where: { userId: user.id } });
console.log(
  `Cleared the second factor for ${user.name} <${user.email}> (was ${user.totpEnabledAt ? "on" : "not set up"}). ` +
    `${ended.count} session${ended.count === 1 ? "" : "s"} ended. They will be asked to enrol again at their next sign-in.`,
);
await prisma.$disconnect();

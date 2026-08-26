/**
 * Promote a user to Nanicle platform admin, so they can reach /admin.
 *
 * There is deliberately no screen for this: the console provisions schools and
 * reads across every tenant, so the only way in is someone with database access
 * granting it. The first admin has to be made this way; after that, add the flag
 * here too rather than building a UI that can escalate itself.
 *
 *   npm run make:admin -- someone@example.com
 *   npm run make:admin -- someone@example.com --revoke
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const email = args.find((arg) => !arg.startsWith("--"))?.trim().toLowerCase();
const revoke = args.includes("--revoke");

if (!email) {
  console.error("Usage: npm run make:admin -- <email> [--revoke]");
  process.exitCode = 1;
} else {
  const user = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { id: true, name: true, email: true, isPlatformAdmin: true },
  });

  if (!user) {
    console.error(`No user with the email ${email}.`);
    process.exitCode = 1;
  } else if (user.isPlatformAdmin === !revoke) {
    console.log(
      `${user.name} <${user.email}> is already ${revoke ? "not " : ""}a platform admin.`,
    );
  } else {
    await prisma.user.update({
      where: { id: user.id },
      data: { isPlatformAdmin: !revoke },
    });
    console.log(
      `${revoke ? "Revoked" : "Granted"} platform admin ${revoke ? "from" : "to"} ${user.name} <${user.email}>.`,
    );
  }
}

await prisma.$disconnect();

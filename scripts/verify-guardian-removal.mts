/**
 * Deleting a guardian takes them off the child, not just off the guardians list.
 *
 *   npm run verify:guardian-removal
 *
 * `deleteGuardian` used to set `deletedAt` and nothing else, so a guardian entered twice and deleted once still
 * showed on the child's page, on the bill, and in the SMS audience, and kept a working portal login. Runs the real
 * `removeGuardian` and the real clean-up migration inside owner transactions that are rolled back, so it writes nothing
 * lasting, and reads the source to confirm the action goes through the one function.
 *
 * Development databases only, like every guard that reads the seed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";
import { removeGuardian } from "@/lib/guardian-removal";
import { demoSchool } from "./fixture.mjs";

const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  if (!ok) failures += 1;
}
class Rollback extends Error {}

const root = resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const school = await demoSchool();
const stamp = Date.now().toString(36);

async function rolledBack(body: (tx: PrismaClient) => Promise<void>) {
  try {
    await db.$transaction(async (tx) => { await body(tx as unknown as PrismaClient); throw new Rollback(); }, { timeout: 120_000, maxWait: 30_000 });
  } catch (error) {
    if (!(error instanceof Rollback)) { console.error(error); failures += 1; }
  }
}

/** A child with two parents entered twice (the duplicate is the PRIMARY and the older), plus a login for the duplicate. */
async function plant(tx: PrismaClient, tag: string) {
  const student = (await tx.student.findFirst({ where: { schoolId: school.id, deletedAt: null }, select: { id: true } }))!;
  await tx.studentGuardian.deleteMany({ where: { studentId: student.id } });
  const make = (n: string) => tx.guardian.create({ data: { schoolId: school.id, firstName: "Probe", lastName: `${tag}${n}`, phone: `0200${stamp.slice(-6)}`.slice(0, 10) } });
  const dup = await make("dup");
  const kept = await make("kept");
  await tx.studentGuardian.create({ data: { schoolId: school.id, studentId: student.id, guardianId: dup.id, relationship: "MOTHER", isPrimary: true, createdAt: new Date(Date.now() - 2000) } });
  await tx.studentGuardian.create({ data: { schoolId: school.id, studentId: student.id, guardianId: kept.id, relationship: "MOTHER", isPrimary: false, createdAt: new Date(Date.now() - 1000) } });
  const user = await tx.user.create({ data: { name: "Probe parent", email: `probe-${tag}-${stamp}@example.test` } });
  await tx.membership.create({ data: { schoolId: school.id, userId: user.id, role: "PARENT", guardianId: dup.id } });
  await tx.session.create({ data: { userId: user.id, tokenHash: `probe-${tag}-${stamp}`, activeSchoolId: school.id, expiresAt: new Date(Date.now() + 3600_000) } });
  return { student, dup, kept, user };
}

console.log("removeGuardian takes everything off the child");
await rolledBack(async (tx) => {
  const { student, dup, kept, user } = await plant(tx, "A");
  const result = await removeGuardian(tx as unknown as TenantTx, school.id, dup.id, null);
  const links = await tx.studentGuardian.findMany({ where: { studentId: student.id } });
  check("the removed guardian is no longer linked to the child", !links.some((l) => l.guardianId === dup.id));
  check("the one that stays is linked", links.some((l) => l.guardianId === kept.id));
  check("and was promoted to primary, so the bill still has an addressee", links.find((l) => l.guardianId === kept.id)?.isPrimary === true);
  check("exactly one primary", links.filter((l) => l.isPrimary).length === 1);
  check("the record itself is kept, marked deleted", (await tx.guardian.findUnique({ where: { id: dup.id } }))?.deletedAt !== null);
  check("the portal login is gone: no membership", (await tx.membership.count({ where: { userId: user.id } })) === 0);
  check("and no session", (await tx.session.count({ where: { userId: user.id } })) === 0);
  check("the answer says what happened", result.links === 1 && result.promoted === 1 && result.loginsRemoved === 1, JSON.stringify(result));
  check("an audit row names it", (await tx.auditLog.count({ where: { action: "guardian.remove", entityId: dup.id } })) === 1);
  const again = await removeGuardian(tx as unknown as TenantTx, school.id, dup.id, null);
  check("removing again changes nothing", again.links === 0 && again.promoted === 0 && again.loginsRemoved === 0, JSON.stringify(again));
});

console.log("\nRemoving the only guardian leaves the child with none, not a stale one");
await rolledBack(async (tx) => {
  const { student, dup, kept } = await plant(tx, "B");
  await removeGuardian(tx as unknown as TenantTx, school.id, kept.id, null);
  const links = await tx.studentGuardian.findMany({ where: { studentId: student.id } });
  check("the primary is untouched when a non-primary is removed", links.length === 1 && links[0]!.guardianId === dup.id && links[0]!.isPrimary);
  await removeGuardian(tx as unknown as TenantTx, school.id, dup.id, null);
  check("nobody linked afterwards", (await tx.studentGuardian.count({ where: { studentId: student.id } })) === 0);
});

console.log("\nA login that is also staff keeps working");
await rolledBack(async (tx) => {
  const { dup, user } = await plant(tx, "C");
  await tx.membership.create({ data: { schoolId: school.id, userId: user.id, role: "ACCOUNTANT" } });
  await removeGuardian(tx as unknown as TenantTx, school.id, dup.id, null);
  const left = await tx.membership.findMany({ where: { userId: user.id } });
  check("only the PARENT membership was removed", left.length === 1 && left[0]!.role === "ACCOUNTANT");
});

console.log("\nThe clean-up migration repairs guardians deleted before the fix");
await rolledBack(async (tx) => {
  const { student, dup, kept, user } = await plant(tx, "D");
  await tx.guardian.update({ where: { id: dup.id }, data: { deletedAt: new Date() } }); // the old behaviour: flag only
  const sql = read("prisma/migrations/20261021153000_remove_links_of_deleted_guardians/migration.sql");
  const statements = sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) await tx.$executeRawUnsafe(statement);
  const links = await tx.studentGuardian.findMany({ where: { studentId: student.id } });
  check("the stale link is gone", !links.some((l) => l.guardianId === dup.id));
  check("the live one was promoted before the link went", links.find((l) => l.guardianId === kept.id)?.isPrimary === true);
  check("the stale login and its session are gone", (await tx.membership.count({ where: { userId: user.id } })) === 0 && (await tx.session.count({ where: { userId: user.id } })) === 0);
  const before = await tx.studentGuardian.count({ where: { schoolId: school.id } });
  for (const statement of statements) await tx.$executeRawUnsafe(statement);
  check("running it again changes nothing", (await tx.studentGuardian.count({ where: { schoolId: school.id } })) === before);
  check("no link to a deleted guardian remains anywhere", (await tx.studentGuardian.count({ where: { guardian: { deletedAt: { not: null } } } })) === 0);
});

console.log("\nWiring");
const action = code("src/lib/guardian-actions.ts");
const del = action.slice(action.indexOf("export async function deleteGuardian"));
check("deleteGuardian goes through removeGuardian in a transaction", /tenantTransaction\([^]*removeGuardian\(/.test(del.slice(0, 900)));
check("and no longer just flags the record", !/guardian\.update\(\{ where: \{ id \}, data: \{ deletedAt/.test(del.slice(0, 900)));
check("the activity feed has words for guardian.remove", /"guardian\.remove":/.test(code("src/lib/dashboard-data.ts")));

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);

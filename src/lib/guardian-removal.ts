import "server-only";

import type { TenantTx } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";

export type GuardianRemoval = {
  /** Children this guardian was linked to. */
  links: number;
  /** Children whose primary contact was this guardian and who now have another one. */
  promoted: number;
  /** Portal logins ended. */
  loginsRemoved: number;
};

/**
 * Remove a guardian properly: mark the record deleted AND take away everything that hung off it.
 *
 * Deleting used to set `deletedAt` and nothing else. The links to the children stayed, and every screen that reads a
 * child's guardians through those links went on showing someone the school had removed: the child's page, the Students
 * list, the bill's addressee, the receipt's payer, the report card, and (the worst of them) the SMS campaign audience,
 * which would have texted them; their portal login also stayed live. An IT admin deleted a guardian entered twice and the
 * duplicate was still on the child. Filtering `deletedAt` at every one of those readers was the alternative, and the
 * next reader written would have forgotten; removing the relationships here means no reader can see a removed guardian.
 *
 *  - the links to children are deleted, and a child who lost its PRIMARY contact gets the oldest remaining one (the
 *    duplicate that was kept), so the bill and the report still have someone to be addressed to;
 *  - the portal login (a PARENT membership) and its sessions are ended, sessions FIRST: the policy on Session shows a
 *    school the sessions of its own members, so once the membership is gone a session with no school chosen would no
 *    longer be visible and would survive. The same order `removeStaff` uses;
 *  - the record keeps its own row (a payment may name it, an SMS log names it), with `deletedAt` set.
 *
 * Idempotent: removing one already removed changes nothing.
 */
export async function removeGuardian(tx: TenantTx, schoolId: string, guardianId: string, actorUserId: string | null): Promise<GuardianRemoval> {
  const links = await tx.studentGuardian.findMany({ where: { guardianId }, select: { studentId: true, isPrimary: true } });
  await tx.studentGuardian.deleteMany({ where: { guardianId } });

  // Children left without a primary: promote the oldest link that remains, if there is one.
  const lostPrimary = [...new Set(links.filter((link) => link.isPrimary).map((link) => link.studentId))];
  let promoted = 0;
  if (lostPrimary.length > 0) {
    const remaining = await tx.studentGuardian.findMany({
      where: { studentId: { in: lostPrimary }, guardian: { deletedAt: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, studentId: true, isPrimary: true },
    });
    const hasPrimary = new Set(remaining.filter((link) => link.isPrimary).map((link) => link.studentId));
    const next = new Map<string, string>();
    for (const link of remaining) {
      if (!hasPrimary.has(link.studentId) && !next.has(link.studentId)) next.set(link.studentId, link.id);
    }
    if (next.size > 0) {
      await tx.studentGuardian.updateMany({ where: { id: { in: [...next.values()] } }, data: { isPrimary: true } });
      promoted = next.size;
    }
  }

  const logins = await tx.membership.findMany({ where: { schoolId, guardianId }, select: { userId: true } });
  if (logins.length > 0) {
    const userIds = [...new Set(logins.map((login) => login.userId))];
    // Only sessions working in THIS school; the same login may hold another's.
    await tx.session.deleteMany({
      where: { userId: { in: userIds }, OR: [{ activeSchoolId: schoolId }, { activeSchoolId: null }] },
    });
    await tx.membership.deleteMany({ where: { schoolId, guardianId } });
  }

  await tx.guardian.updateMany({ where: { id: guardianId, deletedAt: null }, data: { deletedAt: new Date() } });

  const result = { links: links.length, promoted, loginsRemoved: logins.length };
  await writeAudit(tx, { schoolId, actorUserId, action: "guardian.remove", entity: "Guardian", entityId: guardianId, after: result });
  return result;
}

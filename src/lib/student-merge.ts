import "server-only";

import type { TenantTx } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";

/**
 * Merge a duplicate pupil record into the one to keep.
 *
 * ⚠️ This moves a child's money and marks, so it is built to REFUSE rather than guess. Eleven tables point at a
 * pupil. Most carry a unique key that includes the pupil (one score per assessment, one result per term, one
 * invoice per term, one register entry per day), so when BOTH records already hold a row for the same key there
 * is no way to keep both and no way to know which is right. Those are reported as conflicts, naming the table
 * and how many, and NOTHING is changed: the office resolves them (usually by deleting the wrong row's source)
 * and tries again. It runs in the caller's transaction, so a failure part-way leaves everything as it was.
 *
 * Overlaps that ARE safe to settle:
 *   - a guardian linked to both: the removed record's link is dropped (the kept one stays as it was);
 *   - a discount on both for the same year: the removed record's is dropped;
 *   - a CANCELLED invoice on the removed record for a term the kept one has an invoice for: left where it is;
 *   - an enrolment for the same year where one side is WITHDRAWN: the withdrawn one yields.
 * Everything else moves across. The removed record is soft-deleted (kept for the audit trail, like a delete) and
 * blank fields on the kept record are filled from it. The merge is written to the audit log with the counts.
 *
 * Not a "use server" module: it takes a transaction handle, and every export of one is a callable endpoint.
 */
export type MergeConflict = { table: string; count: number; why: string };

export type MergeResult =
  | { ok: true; moved: Record<string, number>; dropped: Record<string, number> }
  | { ok: false; error: string; conflicts: MergeConflict[] };

const FILL = [
  "middleName", "dateOfBirth", "photoUrl", "nationality", "hometown", "religion", "language", "bloodGroup",
  "allergies", "medicalNotes", "specialNeeds", "previousSchool", "admissionDate", "houseId", "programmeId",
] as const;

const both = <T>(a: T[], b: T[], key: (x: T) => string) => {
  const have = new Set(a.map(key));
  return b.filter((x) => have.has(key(x)));
};

export async function mergeStudents(
  tx: TenantTx,
  args: { schoolId: string; actorUserId: string | null; keepId: string; removeId: string },
): Promise<MergeResult> {
  const { schoolId, keepId, removeId } = args;
  const refuse = (error: string, conflicts: MergeConflict[] = []): MergeResult => ({ ok: false, error, conflicts });

  if (keepId === removeId) {
    return refuse("Choose two different records.");
  }
  const people = await tx.student.findMany({ where: { id: { in: [keepId, removeId] }, schoolId } });
  const keep = people.find((p) => p.id === keepId);
  const remove = people.find((p) => p.id === removeId);
  if (!keep || !remove) {
    return refuse("One of those records was not found in this school.");
  }
  if (keep.deletedAt || remove.deletedAt) {
    return refuse("One of those records has already been removed.");
  }

  const conflicts: MergeConflict[] = [];
  const conflict = (table: string, count: number, why: string) => {
    if (count > 0) conflicts.push({ table, count, why });
  };

  // --- Overlaps on a unique key, table by table. ---
  const scoresK = await tx.score.findMany({ where: { studentId: keepId }, select: { assessmentId: true } });
  const scoresR = await tx.score.findMany({ where: { studentId: removeId }, select: { assessmentId: true } });
  conflict("Assessment scores", both(scoresK, scoresR, (x) => x.assessmentId).length, "both records have a score for the same assessment");

  const mockK = await tx.mockScore.findMany({ where: { studentId: keepId }, select: { mockExamId: true, subjectId: true } });
  const mockR = await tx.mockScore.findMany({ where: { studentId: removeId }, select: { mockExamId: true, subjectId: true } });
  conflict("Mock exam scores", both(mockK, mockR, (x) => `${x.mockExamId}|${x.subjectId}`).length, "both records have a mock score for the same subject");

  const subK = await tx.subjectResult.findMany({ where: { studentId: keepId }, select: { termId: true, subjectId: true } });
  const subR = await tx.subjectResult.findMany({ where: { studentId: removeId }, select: { termId: true, subjectId: true } });
  conflict("Subject results", both(subK, subR, (x) => `${x.termId}|${x.subjectId}`).length, "both records have a result for the same subject and term");

  const termK = await tx.termResult.findMany({ where: { studentId: keepId }, select: { termId: true } });
  const termR = await tx.termResult.findMany({ where: { studentId: removeId }, select: { termId: true } });
  conflict("Term results", both(termK, termR, (x) => x.termId).length, "both records have a report card for the same term");

  const attK = await tx.attendanceEntry.findMany({ where: { studentId: keepId }, select: { attendanceDayId: true } });
  const attR = await tx.attendanceEntry.findMany({ where: { studentId: removeId }, select: { attendanceDayId: true } });
  conflict("Register entries", both(attK, attR, (x) => x.attendanceDayId).length, "both records are marked on the same register day");

  const invK = await tx.invoice.findMany({ where: { studentId: keepId }, select: { termId: true } });
  const invR = await tx.invoice.findMany({ where: { studentId: removeId }, select: { id: true, termId: true, status: true } });
  const invHeld = new Set(invK.map((i) => i.termId));
  const invOverlap = invR.filter((i) => invHeld.has(i.termId));
  conflict("Invoices", invOverlap.filter((i) => i.status !== "CANCELLED").length, "both records have a live invoice for the same term");
  const invLeave = new Set(invOverlap.filter((i) => i.status === "CANCELLED").map((i) => i.id));

  const enrK = await tx.enrollment.findMany({ where: { studentId: keepId }, select: { id: true, academicYearId: true, status: true } });
  const enrR = await tx.enrollment.findMany({ where: { studentId: removeId }, select: { id: true, academicYearId: true, status: true } });
  const enrDropRemoved: string[] = [];
  const enrDropKept: string[] = [];
  let enrBad = 0;
  for (const r of enrR) {
    const k = enrK.find((e) => e.academicYearId === r.academicYearId);
    if (!k) continue;
    if (r.status === "WITHDRAWN") enrDropRemoved.push(r.id);
    else if (k.status === "WITHDRAWN") enrDropKept.push(k.id);
    else enrBad += 1;
  }
  conflict("Class placements", enrBad, "both records are in a class in the same academic year: withdraw one placement first");

  if (conflicts.length > 0) {
    return refuse("These two records cannot be merged yet: they both hold the same kind of record.", conflicts);
  }

  // --- Settle the safe overlaps, then move everything else. ---
  const dropped: Record<string, number> = {};
  const moved: Record<string, number> = {};

  const keptGuardians = new Set((await tx.studentGuardian.findMany({ where: { studentId: keepId }, select: { guardianId: true } })).map((g) => g.guardianId));
  const dupLinks = (await tx.studentGuardian.findMany({ where: { studentId: removeId }, select: { id: true, guardianId: true } })).filter((g) => keptGuardians.has(g.guardianId));
  if (dupLinks.length) {
    await tx.studentGuardian.deleteMany({ where: { id: { in: dupLinks.map((l) => l.id) } } });
    dropped["Parent links"] = dupLinks.length;
  }

  const keptDiscounts = await tx.studentDiscount.findMany({ where: { studentId: keepId }, select: { discountId: true, academicYearId: true } });
  const remDiscounts = await tx.studentDiscount.findMany({ where: { studentId: removeId }, select: { id: true, discountId: true, academicYearId: true } });
  const dupDiscounts = remDiscounts.filter((d) => keptDiscounts.some((k) => k.discountId === d.discountId && k.academicYearId === d.academicYearId));
  if (dupDiscounts.length) {
    await tx.studentDiscount.deleteMany({ where: { id: { in: dupDiscounts.map((d) => d.id) } } });
    dropped["Discounts"] = dupDiscounts.length;
  }

  if (enrDropRemoved.length + enrDropKept.length) {
    await tx.enrollment.deleteMany({ where: { id: { in: [...enrDropRemoved, ...enrDropKept] } } });
    dropped["Withdrawn placements"] = enrDropRemoved.length + enrDropKept.length;
  }

  const move = async (label: string, run: () => Promise<{ count: number }>) => {
    const { count } = await run();
    if (count) moved[label] = count;
  };
  await move("Assessment scores", () => tx.score.updateMany({ where: { studentId: removeId }, data: { studentId: keepId } }));
  await move("Mock exam scores", () => tx.mockScore.updateMany({ where: { studentId: removeId }, data: { studentId: keepId } }));
  await move("Subject results", () => tx.subjectResult.updateMany({ where: { studentId: removeId }, data: { studentId: keepId } }));
  await move("Term results", () => tx.termResult.updateMany({ where: { studentId: removeId }, data: { studentId: keepId } }));
  await move("Register entries", () => tx.attendanceEntry.updateMany({ where: { studentId: removeId }, data: { studentId: keepId } }));
  await move("Invoices", () => tx.invoice.updateMany({ where: { studentId: removeId, id: { notIn: [...invLeave] } }, data: { studentId: keepId } }));
  await move("Payments", () => tx.payment.updateMany({ where: { studentId: removeId }, data: { studentId: keepId } }));
  await move("Discounts", () => tx.studentDiscount.updateMany({ where: { studentId: removeId }, data: { studentId: keepId } }));
  await move("Messages", () => tx.message.updateMany({ where: { studentId: removeId }, data: { studentId: keepId } }));
  await move("Class placements", () => tx.enrollment.updateMany({ where: { studentId: removeId }, data: { studentId: keepId } }));
  // A moved link must not become a second PRIMARY guardian for the kept pupil.
  const keptHasPrimary = (await tx.studentGuardian.count({ where: { studentId: keepId, isPrimary: true } })) > 0;
  if (keptHasPrimary) {
    await tx.studentGuardian.updateMany({ where: { studentId: removeId }, data: { isPrimary: false } });
  }
  await move("Parent links", () => tx.studentGuardian.updateMany({ where: { studentId: removeId }, data: { studentId: keepId } }));

  // Blank fields on the kept record are filled from the removed one; filled ones are never overwritten.
  const fill: Record<string, unknown> = {};
  for (const field of FILL) {
    if (keep[field] == null && remove[field] != null) fill[field] = remove[field];
  }
  // The class on the pupil's row is a pointer to the current placement; carry it over when the kept row has none.
  if (!keep.currentClassGroupId && remove.currentClassGroupId) {
    fill.currentClassGroupId = remove.currentClassGroupId;
  }
  if (Object.keys(fill).length) {
    await tx.student.update({ where: { id: keepId }, data: fill });
    moved["Details filled in"] = Object.keys(fill).length;
  }

  await tx.student.update({ where: { id: removeId }, data: { deletedAt: new Date(), currentClassGroupId: null } });

  await writeAudit(tx, {
    schoolId,
    actorUserId: args.actorUserId,
    action: "student.merge",
    entity: "Student",
    entityId: keepId,
    before: { removedId: removeId, removedAdmissionNo: remove.admissionNo, removedName: `${remove.firstName} ${remove.lastName}` },
    after: { keptAdmissionNo: keep.admissionNo, moved, dropped },
  });

  return { ok: true, moved, dropped };
}

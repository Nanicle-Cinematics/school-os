"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { MARKING, LEADERSHIP, MARK_ANY_CLASS, canAccess } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { materialiseComponents } from "@/lib/assessment-templates";
import { computeClassResults } from "@/lib/results-engine";
import { writeAudit } from "@/lib/audit";
import { rosterWhere } from "@/lib/class-roster";
import { ownsSheet } from "@/lib/ownership";
import { checkScore, refusalMessage } from "@/lib/score-limits";

export type SheetState = { error?: string; ok?: string; savedAt?: string };

/**
 * A teacher may only touch a class and subject they are actually assigned.
 * MARK_ANY_CLASS is exempt — a head covering an absent teacher must not be
 * locked out of their own school's marks, and the IT admin keys in the marks
 * teachers hand in on paper.
 */
async function mayTeach(
  auth: { roles: Parameters<typeof canAccess>[0]; staffId: string | null },
  termId: string,
  classGroupId: string,
  subjectId: string,
) {
  if (canAccess(auth.roles, MARK_ANY_CLASS)) {
    return true;
  }
  if (!auth.staffId) {
    return false;
  }
  // Scoped to the term's own year. Unfiltered, an assignment from a year the
  // teacher no longer teaches that class in still opened its sheet — invisibly,
  // because /staff/[id] only ever lists the current year's rows.
  const term = await prisma.term.findUnique({
    where: { id: termId },
    select: { academicYearId: true },
  });
  if (!term) {
    return false;
  }
  const count = await prisma.teachingAssignment.count({
    where: {
      staffId: auth.staffId,
      classGroupId,
      subjectId,
      academicYearId: term.academicYearId,
    },
  });
  return count > 0;
}

/** Create this term's components for one class and subject. */
export async function openSheet(_prev: SheetState, formData: FormData): Promise<SheetState> {
  const auth = await requireRole(MARKING);
  setTenantContext(auth.tenant);

  const termId = String(formData.get("termId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");
  const subjectId = String(formData.get("subjectId") ?? "");

  if (!termId || !classGroupId || !subjectId) {
    return { error: "Choose a term, class and subject." };
  }
  // MARK_ANY_CLASS is exempt from "may teach" without a single read, and a
  // teacher is only proven for the class and subject by an assignment row. Either
  // way the ids are about to be written into new assessments, so they must be this
  // school's own: see ownership.ts.
  if (!(await ownsSheet(termId, classGroupId, subjectId))) {
    return { error: "That term, class or subject was not found." };
  }
  if (!(await mayTeach(auth, termId, classGroupId, subjectId))) {
    return { error: "You are not assigned to teach that subject in that class." };
  }

  const result = await tenantTransaction(
    auth.schoolId,
    (tx) =>
      materialiseComponents(tx, auth.schoolId, { termId, classGroupId, subjectId }, auth.staffId),
    { timeout: 60_000, maxWait: 20_000 },
  );

  if (result.components === 0) {
    return {
      error:
        "No assessment components are set up. A head or proprietor defines them under Settings → Assessment components.",
    };
  }

  revalidatePath("/assessments/sheet");
  if (result.created === 0) {
    return { ok: "The sheet was already open — nothing to add." };
  }
  return { ok: `Opened ${result.created} component${result.created === 1 ? "" : "s"} for marking.` };
}

type Cell = { assessmentId: string; studentId: string; rawScore: number | null; isAbsent: boolean };

/**
 * Save the whole grid — every component for every student — in one transaction.
 *
 * A teacher marking several components used to make a pass over the same forty
 * names per component, on separate screens. This is one screen and one save,
 * which also means a half-finished sheet is never half-saved.
 *
 * Blank still means "not marked yet" and deletes the row; absent still means
 * zero. Conflating those is how a child gets a zero for a test the teacher
 * simply has not reached.
 */
export async function saveSheet(_prev: SheetState, formData: FormData): Promise<SheetState> {
  const auth = await requireRole(MARKING);
  setTenantContext(auth.tenant);

  const termId = String(formData.get("termId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");
  const subjectId = String(formData.get("subjectId") ?? "");

  if (!(await mayTeach(auth, termId, classGroupId, subjectId))) {
    return { error: "You are not assigned to teach that subject in that class." };
  }

  const assessments = await prisma.assessment.findMany({
    where: { termId, classGroupId, subjectId },
  });
  if (assessments.length === 0) {
    return { error: "This sheet is not open yet." };
  }

  // Marks behind a published report card are frozen. Changing one would leave
  // the card parents hold out of step with the sheet, and the next recompute
  // would have to either rewrite the card or contradict it.
  const published = await prisma.termResult.count({
    where: { termId, classGroupId, status: "PUBLISHED" },
  });
  if (published > 0) {
    return {
      error:
        "This class's results are already published, so the marks are locked. Ask a head or proprietor to withdraw the results first if a correction is needed.",
    };
  }

  const byId = new Map(assessments.map((a) => [a.id, a]));

  // The form is a convenience, not the authority: only pupils on this class's
  // roll for the term's year may be scored, whatever ids a request carries.
  const term = await prisma.term.findUnique({
    where: { id: termId },
    select: { academicYearId: true },
  });
  const roster = await prisma.enrollment.findMany({
    where: rosterWhere(term?.academicYearId ?? "", classGroupId),
    select: { studentId: true, student: { select: { firstName: true, lastName: true } } },
  });
  const enrolled = new Set(roster.map((row) => row.studentId));
  const names = new Map(roster.map((row) => [row.studentId, `${row.student.lastName} ${row.student.firstName}`]));

  /**
   * ⚠️ Only LEADERSHIP may raise a component's ceiling from the sheet.
   *
   * Column totals used to be open to anyone with MARKING access, so a
   * component set at Settings → Assessment components to 10 marks could be
   * quietly raised on a single sheet and a score above it typed straight in —
   * the total a proprietor assigned was a suggestion, not a limit. A plain
   * TEACHER's `max:` fields are now ignored outright, whatever the form
   * (client-tampered or not) sent, and every score is capped against the
   * assessment's own persisted maxScore instead.
   */
  const mayChangeTotals = canAccess(auth.roles, LEADERSHIP);
  const newMax = new Map<string, number>();
  for (const [key, value] of mayChangeTotals ? formData.entries() : []) {
    if (!key.startsWith("max:")) {
      continue;
    }
    const id = key.slice("max:".length);
    const assessment = byId.get(id);
    if (!assessment) {
      continue;
    }
    const parsed = Number(String(value).trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { error: `“${value}” is not a valid total for ${assessment.title}.` };
    }
    if (parsed > 1000) {
      return { error: `A total of ${parsed} is too large — components are marked out of 1000 at most.` };
    }
    if (!assessment.maxScore.equals(new Prisma.Decimal(parsed))) {
      newMax.set(id, parsed);
    }
  }

  const approved = assessments.filter((a) => a.status === "APPROVED");

  const cells: Cell[] = [];
  const problems: string[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("score:")) {
      continue;
    }
    // score:<assessmentId>:<studentId>
    const [, assessmentId, studentId] = key.split(":");
    const assessment = byId.get(assessmentId);
    if (!assessment || !studentId || !enrolled.has(studentId)) {
      continue;
    }
    // An approved component is closed; ignore rather than fail, so one locked
    // column does not block saving the other five.
    if (assessment.status === "APPROVED") {
      continue;
    }

    const raw = String(value).trim();
    const isAbsent = formData.get(`absent:${assessmentId}:${studentId}`) === "on";

    if (isAbsent) {
      cells.push({ assessmentId, studentId, rawScore: null, isAbsent: true });
      continue;
    }
    if (raw === "") {
      cells.push({ assessmentId, studentId, rawScore: null, isAbsent: false });
      continue;
    }

    // The component's own total, as persisted. Only LEADERSHIP can have put a different one in
    // `newMax` (see above), so a teacher or an IT admin is always held to what the school set.
    const max = newMax.get(assessmentId) ?? Number(assessment.maxScore);
    const verdict = checkScore(raw, max);
    if (!verdict.ok || verdict.value === null) {
      problems.push(`${names.get(studentId) ?? "A pupil"}, ${assessment.title}: ${verdict.ok ? "not a mark" : verdict.reason}`);
      continue;
    }
    cells.push({ assessmentId, studentId, rawScore: verdict.value, isAbsent: false });
  }
  // Refused as a whole, before anything is written: a half-saved sheet is worse than an unsaved one.
  if (problems.length > 0) {
    return { error: refusalMessage(problems) };
  }

  await tenantTransaction(
    auth.schoolId,
    async (tx) => {
      for (const [id, max] of newMax) {
        if (byId.get(id)?.status === "APPROVED") {
          continue;
        }
        // weight tracks maxScore so the class score stays marks-based — see
        // materialiseComponents for why.
        const value = new Prisma.Decimal(max);
        await tx.assessment.update({
          where: { id },
          data: { maxScore: value, weight: value },
        });
      }

      for (const cell of cells) {
        if (cell.rawScore === null && !cell.isAbsent) {
          await tx.score.deleteMany({
            where: { assessmentId: cell.assessmentId, studentId: cell.studentId },
          });
          continue;
        }
        const data = {
          schoolId: auth.schoolId,
          assessmentId: cell.assessmentId,
          studentId: cell.studentId,
          rawScore: cell.rawScore === null ? null : new Prisma.Decimal(cell.rawScore),
          isAbsent: cell.isAbsent,
          enteredByStaffId: auth.staffId,
        };
        await tx.score.upsert({
          where: {
            assessmentId_studentId: {
              assessmentId: cell.assessmentId,
              studentId: cell.studentId,
            },
          },
          create: data,
          update: data,
        });
      }

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "score.saveSheet",
        entity: "ClassGroup",
        entityId: classGroupId,
        after: {
          subjectId,
          termId,
          marked: cells.filter((c) => c.rawScore !== null).length,
          absent: cells.filter((c) => c.isAbsent).length,
          cleared: cells.filter((c) => c.rawScore === null && !c.isAbsent).length,
          totalsChanged: [...newMax.keys()].length,
        },
      });
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  /**
   * Add the class up, now that the marks have landed.
   *
   * A teacher's job ends when the sheet is full; totting nine subjects into a
   * mark out of 900 is arithmetic, and waiting for a head to press Compute meant
   * the teacher never saw the number their own entry produced. This runs in its
   * OWN transaction, after the marks are safely committed: the totals are
   * derived and can always be recomputed, so a slow or failed roll-up must
   * never cost anybody their typing.
   */
  let totalsError = false;
  try {
    await tenantTransaction(
      auth.schoolId,
      (tx) => computeClassResults(tx, auth.schoolId, termId, classGroupId),
      { timeout: 180_000, maxWait: 30_000 },
    );
  } catch {
    totalsError = true;
  }

  revalidatePath("/assessments/sheet");
  revalidatePath("/results");

  const marked = cells.filter((c) => c.rawScore !== null || c.isAbsent).length;
  const totals = newMax.size > 0 ? `, ${newMax.size} total${newMax.size === 1 ? "" : "s"} changed` : "";
  const skipped =
    approved.length > 0
      ? ` ${approved.length} approved component${approved.length === 1 ? " was" : "s were"} left untouched.`
      : "";
  const tallied = totalsError
    ? " The marks are safe, but the class totals could not be added up just now — try saving again."
    : " Class totals updated.";
  return {
    ok: `Saved ${marked} mark${marked === 1 ? "" : "s"}${totals}.${skipped}${tallied}`,
    savedAt: new Date().toISOString(),
  };
}

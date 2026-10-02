"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { getWholeSchoolPlan, type Decision } from "@/lib/promotion-data";

export type PromotionState = { error?: string; ok?: string };

const DECISIONS: Decision[] = ["PROMOTE", "REPEAT", "GRADUATE", "HOLD"];

/**
 * Roll a class into the next academic year.
 *
 * One transaction for the whole class: a promotion that half-applied would
 * leave some children on next year's roster and some stranded on last year's,
 * and there is no screen that would make that obvious. The budget is raised
 * because a class of forty makes several writes per child.
 */
export async function runPromotion(
  _prev: PromotionState,
  formData: FormData,
): Promise<PromotionState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const classGroupId = String(formData.get("classGroupId") ?? "");
  const sourceYearId = String(formData.get("sourceYearId") ?? "");
  const targetYearId = String(formData.get("targetYearId") ?? "");

  if (!classGroupId || !sourceYearId || !targetYearId) {
    return { error: "Pick a class, the year it is leaving and the year it is entering." };
  }
  if (sourceYearId === targetYearId) {
    return { error: "A class cannot be promoted into the year it is already in." };
  }

  /**
   * ⚠️ The form names the pupils, but only THIS class's roll may be moved.
   *
   * Student and class ids came straight from the request, so a forged one could
   * graduate a child from another class (status GRADUATED, class cleared) or
   * drop them into any class in the school. The roll is read from the database
   * and every submitted id is checked against it; the destinations must be real
   * classes, and the target year must be a different, later one.
   */
  const [sourceYear, targetYear] = await Promise.all([
    prisma.academicYear.findUnique({ where: { id: sourceYearId }, select: { startDate: true } }),
    prisma.academicYear.findUnique({ where: { id: targetYearId }, select: { startDate: true } }),
  ]);
  if (!sourceYear || !targetYear) {
    return { error: "That academic year does not exist." };
  }
  if (targetYear.startDate <= sourceYear.startDate) {
    return { error: "A class can only be promoted into a LATER year than the one it is leaving." };
  }

  const roll = await prisma.enrollment.findMany({
    where: { classGroupId, academicYearId: sourceYearId, status: "ACTIVE" },
    select: { studentId: true },
  });
  const onRoll = new Set(roll.map((row) => row.studentId));

  const studentIds = formData.getAll("student").map(String);
  if (studentIds.some((id) => !onRoll.has(id))) {
    return { error: "Some of those children are not on this class's roll for that year. Reload the page and try again." };
  }
  if (studentIds.length === 0) {
    return { error: "Nobody is enrolled in that class for the year you are promoting from." };
  }

  // Validate the whole plan before writing any of it, so a bad row cannot leave
  // half a class moved.
  type Move = { studentId: string; decision: Decision; destinationId: string | null };
  const moves: Move[] = [];

  for (const studentId of studentIds) {
    const decision = String(formData.get(`decision:${studentId}`) ?? "") as Decision;
    if (!DECISIONS.includes(decision)) {
      return { error: "Every child needs a decision." };
    }

    const destinationId = String(formData.get(`class:${studentId}`) ?? "") || null;
    if ((decision === "PROMOTE" || decision === "REPEAT") && !destinationId) {
      return {
        error:
          "Some children have no class to go into. Create the classes for the next year first, or set those children to repeat or graduate.",
      };
    }
    moves.push({ studentId, decision, destinationId });
  }

  const destinationIds = [...new Set(moves.map((m) => m.destinationId).filter((id): id is string => Boolean(id)))];
  if (destinationIds.length > 0) {
    const real = await prisma.classGroup.count({ where: { id: { in: destinationIds } } });
    if (real !== destinationIds.length) {
      return { error: "One of the destination classes does not exist. Reload the page and try again." };
    }
  }

  const applied = { promoted: 0, repeated: 0, graduated: 0, held: 0 };

  await tenantTransaction(auth.schoolId, async (tx) => {
      for (const move of moves) {
        if (move.decision === "HOLD") {
          applied.held += 1;
          continue;
        }

        if (move.decision === "GRADUATE") {
          await tx.student.update({
            where: { id: move.studentId },
            data: { status: "GRADUATED", currentClassGroupId: null },
          });
          await tx.enrollment.updateMany({
            where: { studentId: move.studentId, academicYearId: sourceYearId },
            data: { status: "COMPLETED" },
          });
          applied.graduated += 1;
          continue;
        }

        // Unique on (student, year), so re-running a promotion corrects the
        // placement instead of creating a second roster row.
        await tx.enrollment.upsert({
          where: {
            studentId_academicYearId: {
              studentId: move.studentId,
              academicYearId: targetYearId,
            },
          },
          create: {
            schoolId: auth.schoolId,
            studentId: move.studentId,
            academicYearId: targetYearId,
            classGroupId: move.destinationId as string,
            status: "ACTIVE",
          },
          update: { classGroupId: move.destinationId as string, status: "ACTIVE" },
        });

        await tx.enrollment.updateMany({
          where: { studentId: move.studentId, academicYearId: sourceYearId },
          data: { status: move.decision === "REPEAT" ? "REPEATED" : "COMPLETED" },
        });

        await tx.student.update({
          where: { id: move.studentId },
          data: { currentClassGroupId: move.destinationId },
        });

        if (move.decision === "REPEAT") {
          applied.repeated += 1;
        } else {
          applied.promoted += 1;
        }
      }

      // One audit row for the run, not forty: the class and the counts are what
      // anyone asking "who moved my child?" actually needs.
      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "promotion.run",
        entity: "ClassGroup",
        entityId: classGroupId,
        after: { sourceYearId, targetYearId, ...applied, students: moves.length },
      });
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  revalidatePath("/promotions");
  revalidatePath("/students");
  revalidatePath("/classes");
  revalidatePath("/dashboard");

  const parts = [
    applied.promoted ? `${applied.promoted} promoted` : null,
    applied.repeated ? `${applied.repeated} repeating` : null,
    applied.graduated ? `${applied.graduated} graduated` : null,
    applied.held ? `${applied.held} left alone` : null,
  ].filter(Boolean);

  return { ok: `Done — ${parts.join(", ")}.` };
}

/**
 * Roll every class at once.
 *
 * The form sends only which classes to include — the plan itself is recomputed
 * here. A whole-school form carrying six hundred children's decisions would be
 * both enormous and trivially tamperable.
 *
 * One transaction PER CLASS rather than one for the school: a class is still
 * never half-moved, but a six-hundred-child transaction on a link this slow
 * would sit well past any sane timeout. If it fails midway, the classes that
 * succeeded stay done and re-running is safe.
 */
export async function runWholeSchoolPromotion(
  _prev: PromotionState,
  formData: FormData,
): Promise<PromotionState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const sourceYearId = String(formData.get("sourceYearId") ?? "");
  const targetYearId = String(formData.get("targetYearId") ?? "");
  const included = new Set(formData.getAll("class").map(String));

  if (!sourceYearId || !targetYearId) {
    return { error: "Pick the year the school is leaving and the year it is entering." };
  }
  if (sourceYearId === targetYearId) {
    return { error: "The school cannot be promoted into the year it is already in." };
  }
  if (included.size === 0) {
    return { error: "Tick at least one class." };
  }

  const [fromYear, toYear] = await Promise.all([
    prisma.academicYear.findUnique({ where: { id: sourceYearId }, select: { startDate: true } }),
    prisma.academicYear.findUnique({ where: { id: targetYearId }, select: { startDate: true } }),
  ]);
  if (!fromYear || !toYear) {
    return { error: "That academic year does not exist." };
  }
  if (toYear.startDate <= fromYear.startDate) {
    return { error: "The school can only be promoted into a LATER year than the one it is leaving." };
  }

  const { plans } = await getWholeSchoolPlan(sourceYearId, targetYearId);
  const chosen = plans.filter((plan) => included.has(plan.classGroup.id) && !plan.blocked);

  if (chosen.length === 0) {
    return { error: "None of the ticked classes have anywhere to go." };
  }

  const totals = { promoted: 0, repeated: 0, graduated: 0, classes: 0 };

  for (const plan of chosen) {
    await tenantTransaction(auth.schoolId, async (tx) => {
        for (const move of plan.moves) {
          if (move.decision === "GRADUATE") {
            await tx.student.update({
              where: { id: move.studentId },
              data: { status: "GRADUATED", currentClassGroupId: null },
            });
            await tx.enrollment.updateMany({
              where: { studentId: move.studentId, academicYearId: sourceYearId },
              data: { status: "COMPLETED" },
            });
            totals.graduated += 1;
            continue;
          }

          await tx.enrollment.upsert({
            where: {
              studentId_academicYearId: {
                studentId: move.studentId,
                academicYearId: targetYearId,
              },
            },
            create: {
              schoolId: auth.schoolId,
              studentId: move.studentId,
              academicYearId: targetYearId,
              classGroupId: move.destinationId as string,
              status: "ACTIVE",
            },
            update: { classGroupId: move.destinationId as string, status: "ACTIVE" },
          });

          await tx.enrollment.updateMany({
            where: { studentId: move.studentId, academicYearId: sourceYearId },
            data: { status: move.decision === "REPEAT" ? "REPEATED" : "COMPLETED" },
          });

          await tx.student.update({
            where: { id: move.studentId },
            data: { currentClassGroupId: move.destinationId },
          });

          if (move.decision === "REPEAT") {
            totals.repeated += 1;
          } else {
            totals.promoted += 1;
          }
        }

        // Audited per class, exactly as a single-class run would be, so the
        // trail reads the same however the office chose to do it.
        await writeAudit(tx, {
          schoolId: auth.schoolId,
          actorUserId: auth.userId,
          action: "promotion.run",
          entity: "ClassGroup",
          entityId: plan.classGroup.id,
          after: {
            sourceYearId,
            targetYearId,
            wholeSchool: true,
            students: plan.moves.length,
            ...plan.counts,
          },
        });
      },
      { timeout: 120_000, maxWait: 20_000 },
    );

    totals.classes += 1;
  }

  revalidatePath("/promotions");
  revalidatePath("/students");
  revalidatePath("/classes");
  revalidatePath("/dashboard");

  const parts = [
    totals.promoted ? `${totals.promoted} promoted` : null,
    totals.repeated ? `${totals.repeated} repeating` : null,
    totals.graduated ? `${totals.graduated} graduated` : null,
  ].filter(Boolean);

  return { ok: `Rolled ${totals.classes} classes over — ${parts.join(", ")}.` };
}

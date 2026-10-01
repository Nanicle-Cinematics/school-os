"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";

export type ClassState = { error?: string; ok?: string };

export async function saveClassGroup(
  _prev: ClassState,
  formData: FormData,
): Promise<ClassState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const id = String(formData.get("id") ?? "");
  const levelId = String(formData.get("levelId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const formTeacherId = String(formData.get("formTeacherId") ?? "");
  const capacityRaw = String(formData.get("capacity") ?? "").trim();
  const capacity = capacityRaw ? Number(capacityRaw) : null;

  if (!levelId) {
    return { error: "Pick the level this class sits in." };
  }
  if (!name) {
    return { error: "Give the class a stream name, e.g. Gold." };
  }
  if (capacity !== null && (!Number.isFinite(capacity) || capacity <= 0)) {
    return { error: "Capacity must be a whole number of seats, or blank." };
  }

  const data = {
    levelId,
    name,
    capacity: capacity === null ? null : Math.trunc(capacity),
    formTeacherId: formTeacherId || null,
  };

  try {
    if (id) {
      await prisma.classGroup.update({ where: { id }, data });
      revalidatePath(`/classes/${id}`);
      revalidatePath("/classes");
      return { ok: `Saved ${name}.` };
    }

    await prisma.classGroup.create({ data: { schoolId: auth.schoolId, ...data } });
    revalidatePath("/classes");
    return { ok: `Added ${name}.` };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: `That level already has a class called ${name}.` };
    }
    throw error;
  }
}

export async function deleteClassGroup(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  // Enrollment cascades on delete at the database level (so a school can be torn
  // down in one go), which means the guard has to live here — deleting a class
  // with a roster would silently erase every enrolment record it holds.
  const enrolled = await prisma.enrollment.count({ where: { classGroupId: id } });
  if (enrolled > 0) {
    redirect(`/classes/${id}?error=has-roster`);
  }

  await prisma.classGroup.delete({ where: { id } });
  revalidatePath("/classes");
  redirect("/classes");
}

/**
 * Set who teaches every subject in one class, in one submit.
 *
 * The per-teacher form adds a single subject at a time, which is right for a
 * correction and hopeless for setup: the GES curriculum gives a level between
 * four and twelve subjects, so a school with one stream per level needs 104
 * assignments before a single teacher can open a mark sheet. This writes a
 * whole class at once, and takes the class's own level as the list of rows so
 * KG is never offered Mathematics.
 *
 * Blank means unassigned, and unassigning is how a mistake is undone — so a row
 * left empty deletes any assignment that was there. Only the current academic
 * year is touched; last year's record of who taught what is history and stays.
 */
export async function saveClassAssignments(
  _prev: ClassState,
  formData: FormData,
): Promise<ClassState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const classGroupId = String(formData.get("classGroupId") ?? "");
  if (!classGroupId) {
    return { error: "No class was submitted." };
  }

  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });
  if (!year) {
    return { error: "No academic year is marked current — set one in Settings first." };
  }

  const classGroup = await prisma.classGroup.findUnique({
    where: { id: classGroupId },
    select: { levelId: true },
  });
  if (!classGroup) {
    return { error: "That class no longer exists." };
  }

  // The submitted teacher for each subject the level offers. Reading the rows
  // from the database rather than from the form is what stops a forged field
  // assigning a subject this level does not teach.
  const offered = await prisma.levelSubject.findMany({
    where: { levelId: classGroup.levelId },
    select: { subjectId: true },
  });

  const wanted = new Map<string, string>();
  for (const { subjectId } of offered) {
    const staffId = String(formData.get(`teacher:${subjectId}`) ?? "").trim();
    if (staffId) {
      wanted.set(subjectId, staffId);
    }
  }

  // Every submitted teacher must actually be teaching staff at this school.
  if (wanted.size > 0) {
    const valid = await prisma.staff.count({
      where: {
        id: { in: [...new Set(wanted.values())] },
        deletedAt: null,
        status: "ACTIVE",
        isTeaching: true,
      },
    });
    if (valid !== new Set(wanted.values()).size) {
      return { error: "One of those teachers is no longer on the teaching staff." };
    }
  }

  const existing = await prisma.teachingAssignment.findMany({
    where: { classGroupId, academicYearId: year.id },
    select: { id: true, subjectId: true, staffId: true },
  });

  const remove = existing.filter((row) => wanted.get(row.subjectId) !== row.staffId);
  const add = [...wanted.entries()].filter(
    ([subjectId, staffId]) =>
      !existing.some((row) => row.subjectId === subjectId && row.staffId === staffId),
  );

  if (remove.length === 0 && add.length === 0) {
    return { ok: "Nothing to change." };
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    if (remove.length > 0) {
      await tx.teachingAssignment.deleteMany({
        where: { id: { in: remove.map((row) => row.id) } },
      });
    }
    if (add.length > 0) {
      await tx.teachingAssignment.createMany({
        data: add.map(([subjectId, staffId]) => ({
          schoolId: auth.schoolId,
          academicYearId: year.id,
          classGroupId,
          subjectId,
          staffId,
        })),
      });
    }
  });

  revalidatePath(`/classes/${classGroupId}`);
  revalidatePath("/staff");

  const assigned = wanted.size;
  const total = offered.length;
  return {
    ok:
      assigned === total
        ? `All ${total} subjects have a teacher.`
        : `Saved — ${assigned} of ${total} subjects have a teacher.`,
  };
}

"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { ACADEMIC, LEADERSHIP, MARKING, canAccess } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { candidateLevel } from "@/lib/mock-data";

export type MockState = { error?: string; ok?: string; savedAt?: string };

/** "2026-11-03" → that day at UTC midnight, or null for anything else. */
function parseDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value ? null : day;
}

/** Set up a mock for this year's candidate class. Leadership only. */
export async function createMock(_prev: MockState, formData: FormData): Promise<MockState> {
  const auth = await requireRole(ACADEMIC);
  setTenantContext(auth.tenant);

  const title = String(formData.get("title") ?? "").trim();
  const rawDate = String(formData.get("sittingDate") ?? "").trim();
  if (!title) return { error: "Give the mock a name, e.g. “Mock 1”." };
  if (title.length > 60) return { error: "Keep the name under 60 characters." };
  const sittingDate = rawDate ? parseDay(rawDate) : null;
  if (rawDate && !sittingDate) return { error: "That date is not valid." };

  const level = await candidateLevel();
  if (!level) return { error: "This school has no JHS classes, so there is no class to sit a mock." };
  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true } });
  if (!year) return { error: "No academic year is marked as current. Set one in Settings → Terms first." };

  const twin = await prisma.mockExam.findFirst({
    where: { levelId: level.id, academicYearId: year.id, title },
    select: { id: true },
  });
  if (twin) return { error: `There is already a mock called “${title}” this year.` };

  await tenantTransaction(auth.schoolId, async (tx) => {
    const mock = await tx.mockExam.create({
      data: { schoolId: auth.schoolId, academicYearId: year.id, levelId: level.id, title, sittingDate },
    });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "mock.create",
      entity: "MockExam",
      entityId: mock.id,
      after: { title, level: level.name },
    });
  });

  revalidatePath("/mocks");
  return { ok: `${title} is set up for ${level.name}. Subject teachers can now enter marks.` };
}

/**
 * Close a mock (marks final, the sheet stops accepting changes) or reopen it.
 * A plain form action: nothing to report back but the page itself.
 */
export async function setMockClosed(formData: FormData): Promise<void> {
  const auth = await requireRole(ACADEMIC);
  setTenantContext(auth.tenant);
  const id = String(formData.get("mockExamId") ?? "");
  const close = formData.get("close") === "1";

  await tenantTransaction(auth.schoolId, async (tx) => {
    const mock = await tx.mockExam.findUnique({ where: { id }, select: { title: true, isClosed: true } });
    if (!mock || mock.isClosed === close) return;
    await tx.mockExam.update({ where: { id }, data: { isClosed: close } });
    // Two literal calls, not `close ? "mock.close" : "mock.reopen"`: verify:activity
    // finds audited actions by scanning for `action: "…"`, and a ternary hides both.
    const entry = { schoolId: auth.schoolId, actorUserId: auth.userId, entity: "MockExam", entityId: id, after: { title: mock.title } };
    if (close) {
      await writeAudit(tx, { ...entry, action: "mock.close" });
    } else {
      await writeAudit(tx, { ...entry, action: "mock.reopen" });
    }
  });
  revalidatePath("/mocks");
}

/**
 * Remove a mock set up by mistake. Refused once any mark is on it: deleting
 * would take the marks with it, and a mock nobody wants is closed, not erased.
 */
export async function deleteMock(_prev: MockState, formData: FormData): Promise<MockState> {
  const auth = await requireRole(ACADEMIC);
  setTenantContext(auth.tenant);
  const id = String(formData.get("mockExamId") ?? "");

  const marks = await prisma.mockScore.count({ where: { mockExamId: id } });
  if (marks > 0) {
    return { error: `This mock already has ${marks} mark${marks === 1 ? "" : "s"} entered, so it cannot be deleted. Close it instead.` };
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const mock = await tx.mockExam.findUnique({ where: { id }, select: { title: true } });
    if (!mock) return;
    await tx.mockExam.delete({ where: { id } });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "mock.delete",
      entity: "MockExam",
      entityId: id,
      before: { title: mock.title },
    });
  });
  revalidatePath("/mocks");
  return { ok: "Mock deleted." };
}

/**
 * Save one class's marks for one subject of a mock.
 *
 * The same rule as the term mark sheet: a teacher may enter only a class and
 * subject they are assigned to IN THE MOCK'S YEAR; leadership may enter any.
 * Marks are out of 100. Blank means not marked yet; absent counts as 0, which
 * is what absence costs in the real exam.
 *
 * Written in bulk — one delete and one insert for the class — rather than a
 * round trip per pupil, which on this link is the difference between a second
 * and a minute (CLAUDE.md, "Send in bulk or don't send").
 */
export async function saveMockSheet(_prev: MockState, formData: FormData): Promise<MockState> {
  const auth = await requireRole(MARKING);
  setTenantContext(auth.tenant);

  const mockExamId = String(formData.get("mockExamId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");
  const subjectId = String(formData.get("subjectId") ?? "");

  const mock = await prisma.mockExam.findUnique({
    where: { id: mockExamId },
    select: { id: true, title: true, isClosed: true, levelId: true, academicYearId: true },
  });
  if (!mock) return { error: "That mock no longer exists." };
  if (mock.isClosed) {
    return { error: `${mock.title} is closed, so its marks are final. A head can reopen it if a correction is needed.` };
  }

  // The class must be a stream of the mock's level, and the subject one the
  // level offers — whatever ids the request carries.
  const classGroup = await prisma.classGroup.findFirst({
    where: { id: classGroupId, levelId: mock.levelId },
    select: { id: true },
  });
  const offered = await prisma.levelSubject.count({ where: { levelId: mock.levelId, subjectId } });
  if (!classGroup || offered === 0) return { error: "Choose a class and subject of this mock." };

  if (!canAccess(auth.roles, LEADERSHIP)) {
    const assigned = auth.staffId
      ? await prisma.teachingAssignment.count({
          where: { staffId: auth.staffId, classGroupId, subjectId, academicYearId: mock.academicYearId },
        })
      : 0;
    if (assigned === 0) return { error: "You are not assigned to teach that subject in that class." };
  }

  const roll = await prisma.enrollment.findMany({
    where: { classGroupId, academicYearId: mock.academicYearId, status: "ACTIVE", student: { deletedAt: null } },
    select: { studentId: true },
  });
  const enrolled = roll.map((row) => row.studentId);

  const rows: { studentId: string; rawScore: Prisma.Decimal | null; isAbsent: boolean }[] = [];
  for (const studentId of enrolled) {
    const isAbsent = formData.get(`absent:${studentId}`) === "on";
    const raw = String(formData.get(`score:${studentId}`) ?? "").trim();
    if (isAbsent) {
      rows.push({ studentId, rawScore: null, isAbsent: true });
      continue;
    }
    if (raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return { error: `“${raw}” is not a mark out of 100. Nothing was saved.` };
    }
    rows.push({ studentId, rawScore: new Prisma.Decimal(value.toFixed(2)), isAbsent: false });
  }

  await tenantTransaction(
    auth.schoolId,
    async (tx) => {
      await tx.mockScore.deleteMany({ where: { mockExamId, subjectId, studentId: { in: enrolled } } });
      if (rows.length > 0) {
        await tx.mockScore.createMany({
          data: rows.map((row) => ({
            schoolId: auth.schoolId,
            mockExamId,
            subjectId,
            studentId: row.studentId,
            rawScore: row.rawScore,
            isAbsent: row.isAbsent,
            enteredByStaffId: auth.staffId,
          })),
        });
      }
      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "mock.saveSheet",
        entity: "MockExam",
        entityId: mockExamId,
        after: {
          title: mock.title,
          classGroupId,
          subjectId,
          marked: rows.filter((r) => !r.isAbsent).length,
          absent: rows.filter((r) => r.isAbsent).length,
        },
      });
    },
    { timeout: 60_000, maxWait: 20_000 },
  );

  revalidatePath("/mocks");
  const marked = rows.length;
  return { ok: `Saved ${marked} mark${marked === 1 ? "" : "s"} for ${mock.title}.`, savedAt: new Date().toISOString() };
}

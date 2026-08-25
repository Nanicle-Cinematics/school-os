"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type TermName } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";

export type TermState = { error?: string; ok?: string };

const SEQUENCE_NAME: Record<number, TermName> = { 1: "FIRST", 2: "SECOND", 3: "THIRD" };

function refresh() {
  revalidatePath("/settings/terms");
  revalidatePath("/settings");
  revalidatePath("/", "layout");
}

function parseDate(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Split an academic year into three terms.
 *
 * Ghanaian schools always run three, so creating a year without them would
 * leave every term-scoped screen — invoicing, score entry — with nothing to
 * attach to. The even split is a starting point the office then corrects; real
 * term dates are set by GES and are never exactly even.
 */
function splitIntoTerms(start: Date, end: Date) {
  const span = end.getTime() - start.getTime();
  const step = Math.floor(span / 3);
  return [1, 2, 3].map((sequence) => {
    const termStart = new Date(start.getTime() + step * (sequence - 1));
    const termEnd =
      sequence === 3 ? new Date(end) : new Date(start.getTime() + step * sequence - 86_400_000);
    return { sequence, name: SEQUENCE_NAME[sequence], startDate: termStart, endDate: termEnd };
  });
}

export async function createAcademicYear(
  _prev: TermState,
  formData: FormData,
): Promise<TermState> {
  const auth = await requireRole(OFFICE);

  const name = String(formData.get("name") ?? "").trim();
  const startDate = parseDate(formData.get("startDate"));
  const endDate = parseDate(formData.get("endDate"));
  const makeCurrent = formData.get("makeCurrent") === "on";

  if (!name) {
    return { error: "Name the year the way the school writes it, e.g. 2027/2028." };
  }
  if (!startDate || !endDate) {
    return { error: "Enter the first and last day of the year." };
  }
  if (startDate >= endDate) {
    return { error: "The year has to end after it starts." };
  }

  const terms = splitIntoTerms(startDate, endDate);

  try {
    await tenantTransaction(async (tx) => {
      const year = await tx.academicYear.create({
        data: { schoolId: auth.schoolId, name, startDate, endDate },
      });

      await tx.term.createMany({
        data: terms.map((term) => ({
          schoolId: auth.schoolId,
          academicYearId: year.id,
          name: term.name,
          sequence: term.sequence,
          startDate: term.startDate,
          endDate: term.endDate,
        })),
      });

      if (makeCurrent) {
        await tx.academicYear.updateMany({
          where: { isCurrent: true },
          data: { isCurrent: false },
        });
        await tx.term.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
        await tx.academicYear.update({ where: { id: year.id }, data: { isCurrent: true } });

        const first = await tx.term.findFirst({
          where: { academicYearId: year.id, sequence: 1 },
        });
        if (first) {
          await tx.term.update({ where: { id: first.id }, data: { isCurrent: true } });
        }
      }

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "academic-year.create",
        entity: "AcademicYear",
        entityId: year.id,
        after: { name, makeCurrent },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: `There is already a year called ${name}.` };
    }
    throw error;
  }

  refresh();
  return {
    ok: `Added ${name} with three terms. Correct their dates below — the split is only a starting point.`,
  };
}

export async function saveTerm(_prev: TermState, formData: FormData): Promise<TermState> {
  const auth = await requireRole(OFFICE);

  const id = String(formData.get("id") ?? "");
  const startDate = parseDate(formData.get("startDate"));
  const endDate = parseDate(formData.get("endDate"));
  const vacationDate = parseDate(formData.get("vacationDate"));
  const nextTermBegins = parseDate(formData.get("nextTermBegins"));

  if (!id) {
    return { error: "Missing term." };
  }
  if (!startDate || !endDate) {
    return { error: "A term needs a first and a last day." };
  }
  if (startDate >= endDate) {
    return { error: "The term has to end after it starts." };
  }
  // Both print on the report card, so a vacation date outside the term it
  // belongs to would go out to parents on paper.
  if (vacationDate && (vacationDate < startDate || vacationDate > endDate)) {
    return { error: "The vacation date has to fall inside the term." };
  }
  if (nextTermBegins && nextTermBegins <= endDate) {
    return { error: "The next term cannot begin before this one ends." };
  }

  await tenantTransaction(async (tx) => {
    await tx.term.update({
      where: { id },
      data: { startDate, endDate, vacationDate, nextTermBegins },
    });

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "term.update",
      entity: "Term",
      entityId: id,
      after: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        vacationDate: vacationDate?.toISOString() ?? null,
      },
    });
  });

  refresh();
  return { ok: "Term dates saved." };
}

export async function deleteAcademicYear(formData: FormData): Promise<void> {
  await requireRole(OFFICE);
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  // Invoice, Assessment, SubjectResult, TermResult and FeeStructure all cascade
  // from Term, which cascades from AcademicYear. Deleting a year that has been
  // used would take a school's billing and grade history with it.
  const year = await prisma.academicYear.findUnique({
    where: { id },
    include: { terms: { select: { id: true } } },
  });
  if (!year || year.isCurrent) {
    return;
  }

  const termIds = year.terms.map((term) => term.id);
  const invoices = await prisma.invoice.count({ where: { termId: { in: termIds } } });
  const results = await prisma.termResult.count({ where: { termId: { in: termIds } } });
  const enrolments = await prisma.enrollment.count({ where: { academicYearId: id } });

  if (invoices > 0 || results > 0 || enrolments > 0) {
    return;
  }

  await prisma.academicYear.delete({ where: { id } });
  refresh();
}

"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { splitIntoTerms } from "@/lib/academic-year";

export type TermState = { error?: string; ok?: string };

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

export async function createAcademicYear(
  _prev: TermState,
  formData: FormData,
): Promise<TermState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

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

  // Two years that overlap make "which year is today in" ambiguous for the
  // register, the dashboard and the invoice carry-forward.
  const clash = await prisma.academicYear.findFirst({
    where: { startDate: { lte: endDate }, endDate: { gte: startDate } },
    select: { name: true },
  });
  if (clash) {
    return { error: `Those dates overlap ${clash.name}. A year has to start after the previous one ends.` };
  }

  const terms = splitIntoTerms(startDate, endDate);

  try {
    await tenantTransaction(auth.schoolId, async (tx) => {
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
  setTenantContext({ schoolId: auth.schoolId });

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

  const current = await prisma.term.findUnique({
    where: { id },
    select: { sequence: true, academicYearId: true, academicYear: { select: { startDate: true, endDate: true } } },
  });
  if (!current) {
    return { error: "That term no longer exists." };
  }
  if (startDate < current.academicYear.startDate || endDate > current.academicYear.endDate) {
    return { error: "A term has to fall inside its academic year." };
  }
  // Terms of one year run in order and may not overlap each other.
  const siblings = await prisma.term.findMany({
    where: { academicYearId: current.academicYearId, id: { not: id } },
    select: { sequence: true, startDate: true, endDate: true, name: true },
  });
  const overlap = siblings.find((other) =>
    other.sequence < current.sequence ? startDate <= other.endDate : endDate >= other.startDate,
  );
  if (overlap) {
    return { error: `That overlaps the ${overlap.name.toLowerCase()} term. Terms must run in order without overlapping.` };
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
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
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });
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
  if (!year) {
    return;
  }

  // Being the current year is deliberately NOT a reason to refuse. A school
  // whose only year was entered wrongly would otherwise be stuck: it cannot be
  // deleted because it is current, and it cannot stop being current because
  // there is nothing else to switch to. What actually needs protecting is
  // attached data, which the checks below cover. Deleting the current year
  // leaves none current, and every screen already says so plainly.

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

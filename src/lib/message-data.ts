import "server-only";

import type { AudienceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalisePhone, type MergeContext } from "@/lib/sms";
import { termLabel } from "@/lib/academic-year";
import { netOutstanding } from "@/lib/invoice-engine";

export type Recipient = {
  phone: string;
  context: MergeContext;
  studentId?: string;
  guardianId?: string;
  staffId?: string;
};

export type AudienceFilter = {
  classGroupIds?: string[];
  levelIds?: string[];
  minBalance?: number;
  phones?: string[];
};

/**
 * Turn an audience choice into a concrete recipient list with merge context.
 *
 * Deduplicated by phone number: a parent with three children in the school gets
 * one message, not three. The first child's details win for merge fields, which
 * is why the debtor audience orders by balance — the parent hears about the
 * largest debt.
 */
export async function resolveAudience(
  schoolId: string,
  type: AudienceType,
  filter: AudienceFilter,
  schoolName: string,
): Promise<Recipient[]> {
  const term = await prisma.term.findFirst({
    where: { isCurrent: true },
    include: { academicYear: true },
  });
  // academic-year.ts holds this map precisely so it stops being written again;
  // this was the ninth copy, and the one that would have said "THIRD Term" for
  // any name the ternary did not anticipate.
  const term_ = term ? `${termLabel(term.name)} Term` : "";

  const base = { school_name: schoolName, term: term_ } satisfies MergeContext;

  if (type === "ALL_STAFF") {
    const staff = await prisma.staff.findMany({
      where: { status: "ACTIVE", deletedAt: null },
      select: { id: true, firstName: true, lastName: true, phone: true },
    });
    return dedupe(
      staff.flatMap((person) => {
        const phone = normalisePhone(person.phone);
        if (!phone) {
          return [];
        }
        return [
          {
            phone,
            staffId: person.id,
            context: {
              ...base,
              guardian_name: `${person.firstName} ${person.lastName}`,
              first_name: person.firstName,
              student_name: "",
            },
          },
        ];
      }),
    );
  }

  if (type === "CUSTOM") {
    return dedupe(
      (filter.phones ?? []).flatMap((raw) => {
        const phone = normalisePhone(raw);
        return phone ? [{ phone, context: { ...base } }] : [];
      }),
    );
  }

  // ⚠️ "Class" or "Level" with nothing ticked means NOBODY, not everybody. The
  // filters below only apply when ids were given, so an empty selection used to
  // fall through to every active pupil and text the whole school.
  if (type === "CLASS" && !filter.classGroupIds?.length) {
    return [];
  }
  if (type === "LEVEL" && !filter.levelIds?.length) {
    return [];
  }

  const students = await prisma.student.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      ...(type === "CLASS" && filter.classGroupIds?.length
        ? { currentClassGroupId: { in: filter.classGroupIds } }
        : {}),
      ...(type === "LEVEL" && filter.levelIds?.length
        ? { currentClassGroup: { levelId: { in: filter.levelIds } } }
        : {}),
      ...(type === "DEBTORS"
        ? { invoices: { some: { balance: { gt: 0 }, status: { not: "CANCELLED" } } } }
        : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      admissionNo: true,
      currentClassGroup: { select: { name: true, level: { select: { name: true } } } },
      guardians: {
        where: type === "DEBTORS" ? { receivesBills: true } : { receivesReports: true },
        include: { guardian: { select: { id: true, firstName: true, lastName: true, phone: true } } },
      },
      invoices: {
        where: { status: { not: "CANCELLED" } },
        select: { total: true, broughtForward: true, balance: true, dueDate: true },
      },
      // Needed to work out what is ACTUALLY owed: see netOutstanding. Reversed
      // receipts are money the family does not have credit for.
      payments: {
        where: { reversedAt: null, status: "CONFIRMED" },
        select: { amount: true },
      },
    },
  });

  const recipients: Recipient[] = [];

  for (const student of students) {
    /**
     * ⚠️ NOT a sum of invoice balances. This audience spans every term a child
     * has been billed for, and each term's invoice carries the last one's
     * balance forward — so summing texted a parent roughly double what they
     * owed, into a template that says "has an outstanding balance of GHS
     * {{balance}}". See netOutstanding.
     */
    const balance = Number(netOutstanding(student.invoices, student.payments));

    if (type === "DEBTORS") {
      const floor = filter.minBalance ?? 0.01;
      if (balance < floor) {
        continue;
      }
    }

    const dueDate = student.invoices.find((invoice) => invoice.dueDate)?.dueDate ?? null;

    for (const link of student.guardians) {
      const phone = normalisePhone(link.guardian.phone);
      if (!phone) {
        continue;
      }
      recipients.push({
        phone,
        studentId: student.id,
        guardianId: link.guardian.id,
        context: {
          ...base,
          student_name: `${student.firstName} ${student.lastName}`,
          first_name: student.firstName,
          admission_no: student.admissionNo,
          class_name: student.currentClassGroup
            ? `${student.currentClassGroup.level.name} ${student.currentClassGroup.name}`
            : "",
          guardian_name: `${link.guardian.firstName} ${link.guardian.lastName}`,
          balance: balance.toFixed(2),
          due_date: dueDate ? dueDate.toLocaleDateString("en-GB") : "",
          reopening_date: term?.nextTermBegins
            ? term.nextTermBegins.toLocaleDateString("en-GB")
            : "",
        },
        // Carried for sorting, dropped before returning.
        ...({ _balance: balance } as object),
      });
    }
  }

  // Largest debt first, so the deduped parent hears about the biggest one.
  if (type === "DEBTORS") {
    recipients.sort(
      (a, b) =>
        Number((b as unknown as { _balance: number })._balance) -
        Number((a as unknown as { _balance: number })._balance),
    );
  }

  return dedupe(recipients);
}

function dedupe(recipients: Recipient[]) {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const recipient of recipients) {
    if (seen.has(recipient.phone)) {
      continue;
    }
    seen.add(recipient.phone);
    out.push(recipient);
  }
  return out;
}

export async function getMessagingSetup() {
  const [templates, campaigns, classGroups, levels, settings] = await Promise.all([
    prisma.messageTemplate.findMany({ orderBy: { name: "asc" } }),
    prisma.messageCampaign.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { createdBy: { select: { name: true } } },
    }),
    prisma.classGroup.findMany({
      orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
      include: { level: { select: { name: true } } },
    }),
    prisma.level.findMany({ orderBy: { order: "asc" } }),
    prisma.schoolSettings.findFirst(),
  ]);

  return { templates, campaigns, classGroups, levels, settings };
}

export async function getCampaign(id: string) {
  return prisma.messageCampaign.findUnique({
    where: { id },
    include: {
      createdBy: { select: { name: true } },
      template: { select: { name: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        take: 500,
        include: {
          student: { select: { firstName: true, lastName: true, admissionNo: true } },
          guardian: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });
}

export async function getMessageStats() {
  const [total, sent, failed, cost] = await Promise.all([
    prisma.message.count(),
    prisma.message.count({ where: { status: { in: ["SENT", "DELIVERED"] } } }),
    prisma.message.count({ where: { status: "FAILED" } }),
    prisma.message.aggregate({ _sum: { cost: true } }),
  ]);
  return { total, sent, failed, cost: Number(cost._sum.cost ?? 0) };
}

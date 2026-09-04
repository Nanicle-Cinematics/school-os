import "server-only";

import type { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { canAccess, FINANCE, OFFICE } from "@/lib/permissions";

export type SearchHit = {
  id: string;
  title: string;
  detail: string;
  href: string;
};

export type SearchResults = {
  query: string;
  groups: { label: string; hits: SearchHit[] }[];
  total: number;
  /** True when a group was capped, so the page can say so honestly. */
  capped: boolean;
};

const PER_GROUP = 6;

/**
 * One box for the things a school office actually looks up: a pupil by name or
 * admission number, a guardian by phone, a receipt, an invoice, a member of
 * staff.
 *
 * Scoped by role, not just by tenant. A bursar searching finds invoices and
 * receipts; a secretary finds pupils and guardians; someone with both finds
 * both. A teacher has neither, which is why the field is not shown to them at
 * all — see `canSearch`.
 *
 * Queries run only for the groups the caller may see, so a bursar's search is
 * three round trips rather than six. On this link that is the difference
 * between a search box and a wait.
 */
export function canSearch(roles: Role[]) {
  return canAccess(roles, OFFICE) || canAccess(roles, FINANCE);
}

export async function search(
  schoolId: string,
  rawQuery: string,
  roles: Role[],
): Promise<SearchResults> {
  const query = rawQuery.trim();
  const groups: SearchResults["groups"] = [];
  let capped = false;

  if (query.length < 2) {
    return { query, groups, total: 0, capped };
  }

  const like = { contains: query, mode: "insensitive" as const };
  const office = canAccess(roles, OFFICE);
  const finance = canAccess(roles, FINANCE);

  const push = (label: string, hits: SearchHit[]) => {
    if (hits.length === 0) return;
    if (hits.length > PER_GROUP) capped = true;
    groups.push({ label, hits: hits.slice(0, PER_GROUP) });
  };

  if (office) {
    const students = await prisma.student.findMany({
      where: {
        schoolId,
        deletedAt: null,
        OR: [
          { firstName: like },
          { lastName: like },
          { middleName: like },
          { admissionNo: like },
        ],
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        admissionNo: true,
        status: true,
        currentClassGroup: { select: { name: true, level: { select: { name: true } } } },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: PER_GROUP + 1,
    });
    push(
      "Pupils",
      students.map((s) => ({
        id: s.id,
        title: `${s.lastName}, ${s.firstName}`,
        detail: [
          s.admissionNo,
          s.currentClassGroup
            ? `${s.currentClassGroup.level.name} ${s.currentClassGroup.name}`
            : "no class",
          s.status.toLowerCase(),
        ].join(" · "),
        href: `/students/${s.id}`,
      })),
    );

    const guardians = await prisma.guardian.findMany({
      where: {
        schoolId,
        deletedAt: null,
        OR: [{ firstName: like }, { lastName: like }, { phone: like }],
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        _count: { select: { students: true } },
      },
      orderBy: [{ lastName: "asc" }],
      take: PER_GROUP + 1,
    });
    push(
      "Guardians",
      guardians.map((g) => ({
        id: g.id,
        title: `${g.firstName} ${g.lastName}`,
        detail: `${g.phone} · ${g._count.students} ${g._count.students === 1 ? "child" : "children"}`,
        href: `/guardians/${g.id}`,
      })),
    );

    const staff = await prisma.staff.findMany({
      where: {
        schoolId,
        deletedAt: null,
        OR: [{ firstName: like }, { lastName: like }, { staffNo: like }],
      },
      select: { id: true, firstName: true, lastName: true, staffNo: true, designation: true },
      orderBy: [{ lastName: "asc" }],
      take: PER_GROUP + 1,
    });
    push(
      "Staff",
      staff.map((s) => ({
        id: s.id,
        title: `${s.firstName} ${s.lastName}`,
        detail: [s.staffNo, s.designation ?? "staff"].join(" · "),
        href: `/staff/${s.id}`,
      })),
    );
  }

  if (finance) {
    const invoices = await prisma.invoice.findMany({
      where: {
        schoolId,
        OR: [
          { invoiceNo: like },
          { student: { OR: [{ firstName: like }, { lastName: like }, { admissionNo: like }] } },
        ],
      },
      select: {
        id: true,
        invoiceNo: true,
        balance: true,
        status: true,
        student: { select: { firstName: true, lastName: true } },
      },
      orderBy: { issueDate: "desc" },
      take: PER_GROUP + 1,
    });
    push(
      "Invoices",
      invoices.map((i) => ({
        id: i.id,
        title: i.invoiceNo,
        detail: `${i.student.lastName}, ${i.student.firstName} · ${i.status.toLowerCase().replace(/_/g, " ")} · balance ${Number(i.balance).toFixed(2)}`,
        href: `/invoices/${i.id}`,
      })),
    );

    const payments = await prisma.payment.findMany({
      where: {
        schoolId,
        OR: [
          { receiptNo: like },
          { reference: like },
          { student: { OR: [{ firstName: like }, { lastName: like }, { admissionNo: like }] } },
        ],
      },
      select: {
        id: true,
        receiptNo: true,
        amount: true,
        method: true,
        student: { select: { firstName: true, lastName: true } },
      },
      orderBy: { paidAt: "desc" },
      take: PER_GROUP + 1,
    });
    push(
      "Receipts",
      payments.map((p) => ({
        id: p.id,
        title: p.receiptNo,
        detail: `${p.student.lastName}, ${p.student.firstName} · ${Number(p.amount).toFixed(2)} · ${p.method.toLowerCase().replace(/_/g, " ")}`,
        // NOT the pupil's page: /students/[id] is OFFICE-only, and a bursar
        // clicking their own receipt would be bounced to the dashboard. The
        // payments list is FINANCE and filters by receipt number.
        href: `/payments?receipt=${encodeURIComponent(p.receiptNo)}`,
      })),
    );
  }

  return { query, groups, total: groups.reduce((sum, g) => sum + g.hits.length, 0), capped };
}

import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function getCurrentTerm() {
  return prisma.term.findFirst({
    where: { isCurrent: true },
    include: { academicYear: true },
  });
}

export async function getFeeSetup() {
  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });
  if (!year) {
    return null;
  }

  // Sequential, not Promise.all — see the connection_limit note in CLAUDE.md.
  const levels = await prisma.level.findMany({ orderBy: { order: "asc" } });
  const categories = await prisma.feeCategory.findMany({
    orderBy: { order: "asc" },
    include: { _count: { select: { structureItems: true, invoiceItems: true } } },
  });
  const structures = await prisma.feeStructure.findMany({
    where: { academicYearId: year.id },
    include: {
      items: { include: { feeCategory: true } },
      level: true,
      term: true,
    },
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
  });
  const terms = await prisma.term.findMany({
    where: { academicYearId: year.id },
    orderBy: { sequence: "asc" },
  });

  return {
    year,
    levels,
    categories,
    terms,
    structures: structures.map((structure) => ({
      ...structure,
      total: structure.items.reduce((acc, item) => acc.add(item.amount), new Prisma.Decimal(0)),
    })),
  };
}

export async function getFeeStructure(id: string) {
  return prisma.feeStructure.findUnique({
    where: { id },
    include: {
      items: { include: { feeCategory: true }, orderBy: { feeCategory: { order: "asc" } } },
      level: true,
      term: true,
      academicYear: true,
    },
  });
}

export async function getDiscounts() {
  return prisma.discount.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
}

import "server-only";

import { Prisma } from "@prisma/client";
import { invoiceItemsPerCategory, structureItemsPerCategory } from "@/lib/scoped-counts";
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
  const categoryRows = await prisma.feeCategory.findMany({ orderBy: { order: "asc" } });
  // Counted for these categories only (see scoped-counts.ts): the relation `_count` this replaced aggregated every
  // school's invoice lines. Sequential, like everything here, to stay inside the connection pool.
  const categoryIds = categoryRows.map((category) => category.id);
  const priced = await structureItemsPerCategory(categoryIds);
  const billed = await invoiceItemsPerCategory(categoryIds);
  const categories = categoryRows.map((category) => ({
    ...category,
    _count: { structureItems: priced.get(category.id) ?? 0, invoiceItems: billed.get(category.id) ?? 0 },
  }));
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

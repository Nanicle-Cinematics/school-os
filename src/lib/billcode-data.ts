import "server-only";

import { prisma } from "@/lib/prisma";

export type BillCodeRow = {
  id: string;
  name: string;
  code: string;
  order: number;
  _count: { invoices: number };
};

export async function getBillCodes(): Promise<BillCodeRow[]> {
  return prisma.billCode.findMany({
    orderBy: { order: "asc" },
    select: {
      id: true,
      name: true,
      code: true,
      order: true,
      _count: { select: { invoices: true } },
    },
  });
}

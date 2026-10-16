import "server-only";

import { prisma } from "@/lib/prisma";
import { findDuplicatePairs, type DuplicatePair } from "@/lib/duplicate-detect";

// Sequential queries, not Promise.all: see the note in class-data.ts. Four connections, and every query under
// row security holds one for several round trips.

export type DuplicateSide = {
  id: string;
  admissionNo: string;
  name: string;
  gender: string;
  dateOfBirth: Date | null;
  status: string;
  className: string | null;
  createdAt: Date;
  guardians: string[];
  invoices: number;
  payments: number;
  scores: number;
  results: number;
  register: number;
  /** All of the above: which record holds more of the child's history. */
  weight: number;
};

export type DuplicateCard = { pair: DuplicatePair; a: DuplicateSide; b: DuplicateSide; suggestKeep: string };

/** Live pupils that look like the same child entered twice, each with what it holds. */
export async function getDuplicateCards(): Promise<DuplicateCard[]> {
  const students = await prisma.student.findMany({
    where: { deletedAt: null },
    select: {
      id: true, admissionNo: true, firstName: true, middleName: true, lastName: true, gender: true,
      dateOfBirth: true, status: true, createdAt: true,
      currentClassGroup: { select: { name: true, level: { select: { name: true } } } },
      guardians: { select: { guardian: { select: { firstName: true, lastName: true, phone: true } } } },
    },
  });

  const pairs = findDuplicatePairs(
    students.map((s) => ({
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      dateOfBirth: s.dateOfBirth,
      guardianPhones: s.guardians.map((g) => g.guardian.phone),
    })),
  );
  if (pairs.length === 0) {
    return [];
  }

  const ids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const tally = async (rows: Promise<{ studentId: string; _count: { _all: number } }[]>) =>
    new Map((await rows).map((r) => [r.studentId, r._count._all]));
  const invoices = await tally(prisma.invoice.groupBy({ by: ["studentId"], where: { studentId: { in: ids }, status: { not: "CANCELLED" } }, _count: { _all: true } }));
  const payments = await tally(prisma.payment.groupBy({ by: ["studentId"], where: { studentId: { in: ids }, reversedAt: null }, _count: { _all: true } }));
  const scores = await tally(prisma.score.groupBy({ by: ["studentId"], where: { studentId: { in: ids } }, _count: { _all: true } }));
  const results = await tally(prisma.termResult.groupBy({ by: ["studentId"], where: { studentId: { in: ids } }, _count: { _all: true } }));
  const register = await tally(prisma.attendanceEntry.groupBy({ by: ["studentId"], where: { studentId: { in: ids } }, _count: { _all: true } }));

  const byId = new Map(students.map((s) => [s.id, s]));
  const side = (id: string): DuplicateSide => {
    const s = byId.get(id)!;
    const side = {
      id,
      admissionNo: s.admissionNo,
      name: [s.firstName, s.middleName, s.lastName].filter(Boolean).join(" "),
      gender: s.gender,
      dateOfBirth: s.dateOfBirth,
      status: s.status,
      className: s.currentClassGroup ? `${s.currentClassGroup.level.name} ${s.currentClassGroup.name}` : null,
      createdAt: s.createdAt,
      guardians: s.guardians.map((g) => `${g.guardian.firstName} ${g.guardian.lastName}`),
      invoices: invoices.get(id) ?? 0,
      payments: payments.get(id) ?? 0,
      scores: scores.get(id) ?? 0,
      results: results.get(id) ?? 0,
      register: register.get(id) ?? 0,
    };
    return { ...side, weight: side.invoices + side.payments + side.scores + side.results + side.register };
  };

  return pairs.map((pair) => {
    const a = side(pair.a);
    const b = side(pair.b);
    // Keep the record that holds more of the child's history; on a tie, the older one (it has the number
    // the family already knows).
    const suggestKeep = a.weight !== b.weight ? (a.weight > b.weight ? a.id : b.id) : a.createdAt <= b.createdAt ? a.id : b.id;
    return { pair, a, b, suggestKeep };
  });
}

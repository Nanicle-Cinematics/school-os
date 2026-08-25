import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma, type TenantTx } from "@/lib/prisma";

type Tx = TenantTx;

export type AuditEntry = {
  schoolId: string;
  actorUserId?: string | null;
  action: string; // "payment.record", "invoice.generate", "expense.delete"
  entity: string; // "Payment"
  entityId: string;
  before?: unknown;
  after?: unknown;
};

/**
 * Every mutation to money or grades goes through here. Pass the transaction
 * client so the audit row commits with the change it describes — an audit trail
 * that can disagree with the ledger is worse than none.
 */
export async function writeAudit(tx: Tx, entry: AuditEntry) {
  await tx.auditLog.create({
    data: {
      schoolId: entry.schoolId,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      before: (entry.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (entry.after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/** For reads outside a transaction — the audit trail shown on a record's page. */
export async function recentAudit(entity: string, entityId: string, take = 20) {
  return prisma.auditLog.findMany({
    where: { entity, entityId },
    orderBy: { createdAt: "desc" },
    take,
    include: { actor: { select: { name: true } } },
  });
}

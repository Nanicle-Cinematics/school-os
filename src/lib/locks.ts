import type { TenantTx } from "@/lib/prisma";

/**
 * Serialise work on one thing for the rest of this transaction.
 *
 * Approve, cancel and reverse all read a status, check it, then act on it — and
 * under Postgres' default isolation two requests can both read "pending" before
 * either writes, so both approve (two journal entries) or both reverse. A
 * transaction-scoped advisory lock makes the second wait; by the time it gets
 * the lock the first has committed, and its own read sees the new status.
 * Released automatically at commit or rollback, so it is safe behind a pooler.
 *
 * Take it BEFORE the read it protects.
 */
export async function lockOn(tx: TenantTx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

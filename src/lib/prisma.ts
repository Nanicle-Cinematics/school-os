import { PrismaClient } from "@prisma/client";
import { getTenantContext, runWithTenantContext } from "@/lib/tenant-context";

// Transient errors typical of pooled/serverless Postgres (Supabase's pgBouncer,
// Neon's scale-to-zero) when a compute wakes or the pooler drops an idle
// connection.
const TRANSIENT_CODES = new Set(["P1001", "P1002", "P1017"]);

function isTransientDbError(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code && TRANSIENT_CODES.has(code)) {
    return true;
  }
  const message = String((error as { message?: string })?.message ?? "");
  // Deliberately does NOT match "Timed out fetching a new connection" (P2024) —
  // retrying pool exhaustion only makes it worse.
  return (
    message.includes("Can't reach database server") ||
    message.includes("Connection reset") ||
    message.includes("kind: Closed")
  );
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Row-Level Security: when enabled, every model operation runs with the tenant
// GUCs set transaction-locally so Postgres enforces isolation. Off by default so
// the flag can ship dormant ahead of the production cutover.
const RLS_ON = process.env.DB_RLS === "on";
const SET_GUC_SQL =
  "SELECT set_config('app.school_id', $1, true), set_config('app.bypass_rls', $2, true)";

function gucArgs() {
  const ctx = getTenantContext();
  return [ctx?.schoolId ?? "", ctx?.bypass ? "on" : "off"] as const;
}

function createPrismaClient() {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

  const client = base.$extends({
    query: {
      async $allOperations({ model, args, query }) {
        const exec = () => {
          // Raw ops (no model) and interactive-tx ops (GUC already set) run
          // as-is. Everything else is wrapped so the tenant GUC and the query
          // share one transaction/connection — pooler-safe.
          if (!RLS_ON || !model || getTenantContext()?.inTx) {
            return query(args);
          }
          const [sid, bypass] = gucArgs();
          return base
            .$transaction([base.$executeRawUnsafe(SET_GUC_SQL, sid, bypass), query(args)])
            .then((res: unknown[]) => res[1]);
        };

        const maxAttempts = 4;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            return await exec();
          } catch (error) {
            if (attempt === maxAttempts || !isTransientDbError(error)) {
              throw error;
            }
            await delay(200 * 2 ** attempt - 100);
          }
        }
        throw new Error("prisma retry loop exhausted");
      },
    },
  });

  return client;
}

type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

/**
 * The transaction client handed to tenantTransaction callbacks. This is the
 * EXTENDED client's tx type, not Prisma.TransactionClient — the two are not
 * assignable to each other, so every helper that takes a `tx` must use this.
 */
export type TenantTx = Parameters<Parameters<ExtendedPrismaClient["$transaction"]>[0]>[0];

const globalForPrisma = globalThis as unknown as {
  prisma?: ExtendedPrismaClient;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Default transaction budget. Prisma's own default is 5s, which is far too
 * tight here: the database is in Frankfurt and a single interactive
 * transaction makes several round trips, so ordinary writes were dying with
 * P2028 ("transaction not found"). Bulk work passes its own larger budget.
 */
export const TX_OPTS = { timeout: 30_000, maxWait: 15_000 } as const;

// Run an interactive transaction with the tenant GUC set as its first statement,
// so RLS applies to every write inside it. Replaces raw prisma.$transaction for
// all tenant-scoped multi-statement writes (invoice generation, payment
// allocation, number-sequence increments). Inherits the current request's
// tenant context.
export async function tenantTransaction<T>(
  fn: (tx: TenantTx) => Promise<T>,
  opts?: { timeout?: number; maxWait?: number },
): Promise<T> {
  const ctx = getTenantContext() ?? {};
  return prisma.$transaction(async (tx) => {
    if (RLS_ON) {
      const [sid, bypass] = gucArgs();
      await tx.$executeRawUnsafe(SET_GUC_SQL, sid, bypass);
    }
    return runWithTenantContext({ ...ctx, inTx: true }, () => fn(tx));
  }, opts ?? TX_OPTS);
}

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

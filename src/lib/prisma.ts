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

// Row-Level Security: every model operation runs with the tenant GUCs set
// transaction-locally so Postgres enforces isolation. Live — see the Tenancy
// section of CLAUDE.md; the policies are applied by `npm run db:rls`.
const RLS_ON = process.env.DB_RLS === "on";
const SET_GUC_SQL =
  "SELECT set_config('app.school_id', $1, true), set_config('app.bypass_rls', $2, true)";

function gucArgs() {
  const ctx = getTenantContext();
  return [ctx?.schoolId ?? "", ctx?.bypass ? "on" : "off"] as const;
}

function createPrismaClient() {
  // The running app connects as the restricted role (no BYPASSRLS, owns
  // nothing), so the policies in scripts/apply-rls.mjs actually bind to it.
  // DATABASE_URL stays the owner connection for the Prisma CLI, the seed and
  // the admin-side verify scripts, which must not be tenant-scoped.
  const url = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;

  const base = new PrismaClient({
    ...(url ? { datasources: { db: { url } } } : {}),
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

  // Forward reference to the EXTENDED client. The GUC statement and the query it
  // guards must be issued through the same client instance, or Prisma does not
  // enlist them in one transaction: set_config(..., true) is transaction-local,
  // so the query then runs on another connection with no tenant set and matches
  // no rows. Using `base` here silently disabled every policy.
  // Assigned below, once the extension it refers to exists; a const cannot
  // express that cycle.
  // eslint-disable-next-line prefer-const
  let extended: PrismaClient;

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
          return extended
            .$transaction([extended.$executeRawUnsafe(SET_GUC_SQL, sid, bypass), query(args)])
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

  // Only $transaction and $executeRawUnsafe are used through this handle, and
  // both exist on the base type; the cast avoids a circular type reference.
  extended = client as unknown as PrismaClient;
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

/**
 * Run an interactive transaction with the tenant GUC set as its first statement,
 * so RLS applies to every write inside it. Replaces raw prisma.$transaction for
 * all tenant-scoped multi-statement writes (invoice generation, payment
 * allocation, number-sequence increments).
 *
 * The school is passed in, not inferred. It used to come from the ambient
 * AsyncLocalStorage context, which `requireAuth` sets with `enterWith` — and
 * `enterWith` called inside a nested async function does NOT reliably propagate
 * back to its caller's continuation. In a server action the context was
 * therefore empty, the GUC was set to '', and every WITH CHECK rejected the row
 * with 42501. Every caller already holds `auth.schoolId`; requiring it makes the
 * tenant a fact of the call rather than a hope about the runtime.
 *
 * The callback also runs inside runWithTenantContext, so reads issued on `tx`
 * see the same tenant.
 */
export async function tenantTransaction<T>(
  schoolId: string,
  fn: (tx: TenantTx) => Promise<T>,
  opts?: { timeout?: number; maxWait?: number },
): Promise<T> {
  const ctx = getTenantContext() ?? {};
  return prisma.$transaction(async (tx) => {
    if (RLS_ON) {
      await tx.$executeRawUnsafe(SET_GUC_SQL, schoolId, ctx.bypass ? "on" : "off");
    }
    return runWithTenantContext({ ...ctx, schoolId, inTx: true }, () => fn(tx));
  }, opts ?? TX_OPTS);
}

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

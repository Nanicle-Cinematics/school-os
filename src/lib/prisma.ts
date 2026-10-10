import { Prisma, PrismaClient } from "@prisma/client";
import { ROLE_ATTRIBUTES_SQL, roleProblem, type RoleAttributes } from "@/lib/db-role";
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

/**
 * The models Postgres will filter to NOTHING without a tenant GUC.
 *
 * Read off the schema rather than listed by hand, for the reason apply-rls.mjs
 * enumerates tables from the database: a list maintained by remembering is a
 * list that is wrong the first time somebody forgets. `School` is scoped by its
 * own `id` rather than a `schoolId` column — the same special case the RLS
 * scripts carry.
 */
const TENANT_MODELS = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.name === "School" || m.fields.some((f) => f.name === "schoolId"))
    .map((m) => m.name),
);

/** Operations that change data. Everything else is a read and stays allowed. */
const WRITES = new Set([
  "create", "createMany", "createManyAndReturn",
  "update", "updateMany", "updateManyAndReturn",
  "upsert", "delete", "deleteMany",
]);

export class SchoolReadOnlyError extends Error {
  constructor(model: string, operation: string) {
    super(
      `This school is read-only — its subscription is not active, so ${operation} on ${model} is refused. ` +
        `Records can still be read and printed. Settle the subscription, or change it in the Nanicle console.`,
    );
    this.name = "SchoolReadOnlyError";
  }
}

export class TenantContextMissingError extends Error {
  constructor(model: string) {
    super(
      `No tenant context for a query on ${model}. Under RLS this cannot match a single row, ` +
        `so it would answer "nothing here" for a school with plenty. Call ` +
        `setTenantContext(auth.tenant) in this frame — an action must do it itself, ` +
        `enterWith does not reach a caller — or withBypass() if the query is deliberately ` +
        `cross-tenant, as a login or the platform console is.`,
    );
    this.name = "TenantContextMissingError";
  }
}

/**
 * Refuse a tenant query that has no tenant.
 *
 * ⚠️ Without this the GUC is simply set to the empty string and the query RUNS:
 * every policy fails to match, nothing comes back, and the caller cannot tell
 * "this school has none" from "nobody said which school". That silence is this
 * codebase's most expensive recurring bug — a forged write onto a frozen grading
 * scale SUCCEEDED because the guard reading ahead of it saw zero rows, and a dev
 * server that had quietly lost the context served "0 on roll" to a school of 44
 * and a 404 from the one page that checks rather than renders empty.
 *
 * Both intents are already written down everywhere they are meant: actions call
 * setTenantContext, session.ts wraps its pre-tenant reads in withBypass. This
 * only fires where NEITHER was said, which is always a bug — so it throws in
 * production too. A page that says a school has nothing is worse than one that
 * says what went wrong.
 */
function assertTenantContext(model: string) {
  const ctx = getTenantContext();
  if (ctx?.bypass || ctx?.schoolId) {
    return;
  }
  if (TENANT_MODELS.has(model)) {
    throw new TenantContextMissingError(model);
  }
}

let roleVerified: Promise<void> | undefined;

/**
 * Ask Postgres, once per process, whether the role we connected as can skip
 * row security.
 *
 * ⚠️ The boot guard below proves APP_DATABASE_URL is SET. It cannot prove the
 * role behind it is the restricted one: the owner's connection string satisfies
 * it equally well, and with the owner every policy is skipped while the site
 * boots and every page renders. See db-role.ts for the whole story.
 *
 * In production a bypassing role is a refusal to serve, for the reason the boot
 * guard is: a school that cannot be told apart from its neighbour is worse than
 * an outage. Elsewhere it is a loud warning, because scripts run with
 * DB_RLS=on and the owner's URL on purpose (the admin-side verify scripts), and
 * ALLOW_UNSCOPED_DB=1 remains the deliberate way to run without isolation.
 *
 * The result is remembered only when it is an answer. A dropped connection must
 * not be remembered as "fine", and must not be remembered as "broken" either.
 */
function verifyRestrictedRole(client: Pick<PrismaClient, "$queryRawUnsafe">): Promise<void> {
  roleVerified ??= (async () => {
    const [row] = await client.$queryRawUnsafe<RoleAttributes[]>(ROLE_ATTRIBUTES_SQL);
    const problem = roleProblem(row);
    if (!problem) {
      return;
    }
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_UNSCOPED_DB !== "1") {
      throw new Error(`Tenant isolation is not in force. ${problem}`);
    }
    console.error(`⚠ ${problem}`);
  })().catch((error: unknown) => {
    roleVerified = undefined;
    throw error;
  });
  return roleVerified;
}

/**
 * The Supabase project a connection string actually points at, from its
 * pooler username (`school_os_app.<ref>` / `postgres.<ref>`).
 */
function supabaseRef(url: string | undefined): string | null {
  return url?.match(/^postgresql:\/\/[^.:]+\.([a-z0-9]+):/)?.[1] ?? null;
}

function createPrismaClient() {
  /**
   * ⚠️ APP_DATABASE_URL and DATABASE_URL disagreeing on WHICH PROJECT is a
   * silent wrong-database connection, not a config nuance — and it already
   * happened once. A script run as `tsx --env-file=.env.prod` had Node set
   * DATABASE_URL to production correctly, but `.env.prod` deliberately has
   * no APP_DATABASE_URL (Vercel supplies that one), and something in the
   * loading chain filled the gap from dev's plain `.env` — which DOES set
   * it. `??` below then picked the leaked dev value over the correct prod
   * one, and a "production" check quietly read dev's demo school instead,
   * nearly triggering a real restore-over-production based on a phantom
   * data-loss alarm. Refusing to start on a mismatch turns that into a
   * loud failure at the first query instead of a wrong answer nobody
   * questioned.
   */
  const appRef = supabaseRef(process.env.APP_DATABASE_URL);
  const ownerRef = supabaseRef(process.env.DATABASE_URL);
  if (appRef && ownerRef && appRef !== ownerRef) {
    throw new Error(
      `APP_DATABASE_URL and DATABASE_URL point at different Supabase projects ` +
        `(${appRef} vs ${ownerRef}). One of them leaked in from the wrong .env file ` +
        `— do not proceed on a guess about which is right. Fix the environment first.`,
    );
  }

  // The running app connects as the restricted role (no BYPASSRLS, owns
  // nothing), so the policies in scripts/apply-rls.mjs actually bind to it.
  // DATABASE_URL stays the owner connection for the Prisma CLI, the seed and
  // the admin-side verify scripts, which must not be tenant-scoped.
  const url = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;

  // Falling back to the owner connection in production would silently disable
  // tenant isolation — the exact failure this codebase already shipped once,
  // where one school could read another's students, guardians and invoices.
  // A missing variable must stop the deployment, not quietly widen access.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_UNSCOPED_DB !== "1" &&
    (!process.env.APP_DATABASE_URL || process.env.DB_RLS !== "on")
  ) {
    throw new Error(
      "Tenant isolation is not configured: set APP_DATABASE_URL (the restricted role, see scripts/apply-rls.mjs) and DB_RLS=on. " +
        "To run without isolation deliberately — a single-tenant demo, say — set ALLOW_UNSCOPED_DB=1.",
    );
  }

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
      async $allOperations({ model, operation, args, query }) {
        /**
         * A school that has not paid can be READ but not written.
         *
         * ⚠️ ABOVE the early return below, and that placement is the whole
         * correctness of it. Inside `exec` this check sat after
         * `if (!RLS_ON || !model || inTx) return query(args)`, which skipped it
         * in two situations that matter: any deployment with DB_RLS off, and —
         * far worse — every operation inside `tenantTransaction`, which is how
         * most multi-statement writes in this app are made. CI caught it by
         * running with RLS off; the transaction hole would have reached
         * production, where the guard looks perfect and lets invoicing,
         * promotion and results through.
         *
         * This rule depends on no GUC and no connection state, so it belongs
         * before anything that does.
         *
         * Reads are untouched on purpose — a head teacher mid-term can still
         * look a pupil up, print a report card and see what is owed, and so can
         * every parent: the portal only reads, so a school's unpaid invoice
         * never reaches the families. `withBypass` lifts it, which is what the
         * Nanicle console needs to change the subscription that caused it.
         */
        const subscription = getTenantContext();
        if (
          model &&
          subscription?.readOnly &&
          !subscription.bypass &&
          WRITES.has(operation) &&
          TENANT_MODELS.has(model)
        ) {
          throw new SchoolReadOnlyError(model, operation);
        }

        const exec = async () => {
          // Raw ops (no model) and interactive-tx ops (GUC already set) run
          // as-is. Everything else is wrapped so the tenant GUC and the query
          // share one transaction/connection — pooler-safe.
          if (!RLS_ON || !model || getTenantContext()?.inTx) {
            return query(args);
          }
          await verifyRestrictedRole(base);
          assertTenantContext(model);

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
  if (RLS_ON) {
    // The first query of a request is often a transaction, which skips the
    // per-operation path above. Raw statements carry no model, so asking on
    // `prisma` here cannot recurse into this check.
    await verifyRestrictedRole(prisma);
  }
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

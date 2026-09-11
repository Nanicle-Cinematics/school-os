import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";

// Per-request tenant context that drives Row-Level Security. `schoolId` scopes
// DB access to one tenant; `bypass` lifts RLS for auth / school resolution /
// platform-admin / system paths; `inTx` marks that the GUC is already set on the
// current interactive transaction (so ops don't re-wrap).
export type TenantContext = {
  schoolId?: string;
  bypass?: boolean;
  inTx?: boolean;
  /**
   * The school may be read but not written — an expired trial, or a subscription
   * the platform has suspended. Carried here rather than checked in each action
   * because there are sixty-odd of them and "remember to add the check" is how
   * this codebase has shipped every silent hole it has had.
   */
  readOnly?: boolean;
};

// Keep a single AsyncLocalStorage instance across dev HMR reloads, otherwise the
// Prisma extension and setTenantContext can end up reading/writing different
// stores and the tenant context appears empty.
const globalForTenant = globalThis as unknown as { __tenantStorage?: AsyncLocalStorage<TenantContext> };
const storage = globalForTenant.__tenantStorage ?? new AsyncLocalStorage<TenantContext>();
globalForTenant.__tenantStorage = storage;

/**
 * Request-scoped fallback for the context.
 *
 * `enterWith` sets the store for the current async context, which is enough
 * inside one function but does NOT survive React's render boundaries: a page
 * component that calls requireAuth and then queries can end up on a different
 * branch, where getStore() is empty and every tenant-scoped read matches no row.
 * React's `cache` gives one object per request, which those branches do share.
 * AsyncLocalStorage stays the primary source — it is what `run`-based callers
 * (tenantTransaction, withBypass, the verify scripts) rely on, and it works
 * outside React where `cache` does not.
 */
const requestHolder = cache((): { ctx?: TenantContext } => ({}));

function holder(): { ctx?: TenantContext } | undefined {
  try {
    return requestHolder();
  } catch {
    return undefined; // outside a React request; ALS is the only source
  }
}

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore() ?? holder()?.ctx;
}

/**
 * Set the context for the remainder of the current request.
 *
 * ⚠️ `readOnly` is CARRIED FORWARD unless the caller says otherwise, and that is
 * load-bearing. Every one of the sixty-odd server actions calls
 * `setTenantContext({ schoolId: auth.schoolId })` immediately after requireRole
 * — which is correct, and which, with replace semantics, threw away the
 * `readOnly` requireAuth had just resolved from the subscription. The guard in
 * prisma.ts would then have been perfect and reached by nothing: an unpaid
 * school would write exactly as before, and every check would have passed.
 *
 * The same school, re-scoped, keeps what was decided about it. Naming a
 * DIFFERENT school, or passing readOnly explicitly, replaces it as before.
 */
export function setTenantContext(ctx: TenantContext): void {
  const previous = getTenantContext();
  const sameSchool = previous?.schoolId && previous.schoolId === ctx.schoolId;
  const next: TenantContext =
    sameSchool && ctx.readOnly === undefined && previous?.readOnly !== undefined
      ? { ...ctx, readOnly: previous.readOnly }
      : ctx;

  const store = holder();
  if (store) {
    store.ctx = next;
  }
  storage.enterWith(next);
}

export function runWithTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Await inside the storage scope, not outside it.
 *
 * Prisma promises are lazy: calling `prisma.x.findMany()` builds a thenable and
 * executes nothing. If `storage.run()` merely RETURNS that promise, the query —
 * and with it the extension hook that reads this context — runs after the scope
 * has already exited, and `getStore()` gives undefined. Every RLS-protected read
 * then sees no tenant and matches no row, which looks exactly like a permissions
 * bug. Awaiting here keeps execution inside the scope.
 */
function runAsync<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, async () => await fn());
}

// Run a single operation with RLS lifted, then restore the surrounding context.
// For legitimately cross-tenant reads inside a tenant-scoped request (e.g. a
// parent with children in two schools, or the platform admin console).
export function withBypass<T>(fn: () => Promise<T>): Promise<T> {
  return runAsync({ bypass: true }, fn);
}

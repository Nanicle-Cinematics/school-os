import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

// Per-request tenant context that drives Row-Level Security. `schoolId` scopes
// DB access to one tenant; `bypass` lifts RLS for auth / school resolution /
// platform-admin / system paths; `inTx` marks that the GUC is already set on the
// current interactive transaction (so ops don't re-wrap).
export type TenantContext = { schoolId?: string; bypass?: boolean; inTx?: boolean };

// Keep a single AsyncLocalStorage instance across dev HMR reloads, otherwise the
// Prisma extension and setTenantContext can end up reading/writing different
// stores and the tenant context appears empty.
const globalForTenant = globalThis as unknown as { __tenantStorage?: AsyncLocalStorage<TenantContext> };
const storage = globalForTenant.__tenantStorage ?? new AsyncLocalStorage<TenantContext>();
globalForTenant.__tenantStorage = storage;

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

// Set/replace the context for the remainder of the current request. Used by the
// auth guards, which run before any tenant data access.
export function setTenantContext(ctx: TenantContext): void {
  storage.enterWith(ctx);
}

export function runWithTenantContext<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

// Run a single operation with RLS lifted, then restore the surrounding context.
// For legitimately cross-tenant reads inside a tenant-scoped request (e.g. a
// parent with children in two schools, or the platform admin console).
export function withBypass<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ bypass: true }, fn);
}

import Link from "next/link";
import { logout } from "@/lib/auth-actions";
import { requireGuardian } from "@/lib/portal-auth";

/**
 * The parent portal's chrome.
 *
 * Deliberately NOT the staff layout. A parent gets no navigation rail, no
 * search, no term countdown — those are tools for running a school, and a
 * parent signing in on a phone to check a balance should see the school's name,
 * their children, and nothing that implies they can act on the school's behalf.
 *
 * requireGuardian here establishes the tenant context for every page below, and
 * refuses a login that is not a guardian, so no portal page has to re-check that
 * it is being opened by the right kind of person.
 */
export default async function PortalLayout({ children }: LayoutProps<"/">) {
  const ctx = await requireGuardian();

  return (
    <div className="flex min-h-full flex-col bg-slate-50">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-3 px-4">
          <Link href="/portal" className="min-w-0 flex-1">
            <p className="truncate text-sm font-extrabold tracking-tight text-slate-900">
              {ctx.schoolName}
            </p>
            <p className="truncate text-xs text-slate-500">Parent portal</p>
          </Link>

          <div className="hidden text-right sm:block">
            <p className="truncate text-sm font-bold text-slate-900">{ctx.name}</p>
          </div>

          <form action={logout}>
            <button
              type="submit"
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</main>

      <footer className="mx-auto w-full max-w-3xl px-4 pb-8 pt-2">
        <p className="text-xs text-slate-400">
          Questions about a bill or a report card? Speak to the school office —
          this portal shows what the school has recorded and published.
        </p>
      </footer>
    </div>
  );
}

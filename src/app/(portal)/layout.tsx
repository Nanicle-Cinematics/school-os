import Link from "next/link";
import { redirect } from "next/navigation";
import { ThemeToggle } from "../theme-toggle";
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

  // A parent signed in with the temporary password the office read to them gets
  // one screen until they replace it. /account/password sits outside this route
  // group precisely so this redirect cannot land on itself.
  if (ctx.mustChangePassword) {
    redirect("/account/password");
  }

  return (
    <div className="flex min-h-full flex-col bg-slate-50">
      {/* The same frosted chrome as the staff app. A parent and a bursar are
          looking at one product, and the portal being the one screen left on the
          old treatment is exactly how a re-skin ends up half-done. */}
      <header className="sticky top-0 z-40 border-b border-hairline bg-chrome backdrop-blur-xl">
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

          <ThemeToggle />
          <form action={logout}>
            <button
              type="submit"
              className="rounded-full border border-hairline px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
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

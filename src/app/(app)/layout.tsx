import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth";
import { navFor, roleLabel } from "@/lib/permissions";
import { canSearch } from "@/lib/search-data";
import { ThemeToggle } from "../theme-toggle";
import { logout } from "@/lib/auth-actions";
import { prisma } from "@/lib/prisma";
import { Sidebar, MobileNav, type RailTerm } from "./nav";

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });

/** Kept out of the component body: reading the clock during render is impure. */
function daysUntil(date: Date) {
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // Establishes the tenant context for every query below this layout.
  const auth = await requireAuth();

  // Same rule for staff: a login created by the office carries a temporary
  // password, and it stops working as a way in once seen. /account/password is
  // outside this group so the redirect has somewhere to land.
  if (auth.mustChangePassword) {
    redirect("/account/password");
  }

  const sections = navFor(auth.roles);

  // The current term drives almost every screen, so the rail keeps it in view.
  const term = await prisma.term.findFirst({
    where: { isCurrent: true },
    include: { academicYear: true },
  });

  const railTerm: RailTerm | null = term
    ? {
        label: `${TERM_NAME[term.name] ?? term.name} Term · ${term.academicYear.name}`,
        closes: term.vacationDate ? dayFmt.format(term.vacationDate) : null,
        daysLeft: term.vacationDate ? daysUntil(term.vacationDate) : null,
      }
    : null;

  const school = { name: auth.schoolName, shortName: auth.schoolShortName };
  // A teacher has two screens and nothing to search; the box would be a door to
  // a page that redirects them straight back.
  const showSearch = canSearch(auth.roles);

  const initials = auth.name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="flex min-h-full bg-slate-50 print:block print:bg-white">
      <Sidebar sections={sections} school={school} term={railTerm} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The app chrome is not part of anything a school hands out — it printed
            on report cards and fee invoices alike until this was added. */}
        {/* Frosted, like the rail: content scrolls UNDER this rather than
            stopping at an opaque bar, which is the whole of the macOS effect
            and the reason both materials carry alpha instead of a flat fill. */}
        <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-3 border-b border-hairline bg-chrome px-4 backdrop-blur-xl lg:px-7 print:hidden">
          <MobileNav sections={sections} school={school} term={railTerm} />

          <div className="min-w-0 lg:hidden">
            <p className="truncate text-sm font-extrabold tracking-tight text-slate-900">
              {auth.schoolName}
            </p>
          </div>

          <div className="hidden min-w-0 lg:block">
            {railTerm ? (
              <p className="truncate text-sm font-semibold text-slate-600">{railTerm.label}</p>
            ) : (
              <p className="truncate text-sm font-semibold text-amber-600">No current term set</p>
            )}
          </div>

          {showSearch ? (
            <form method="get" action="/search" className="ml-2 hidden min-w-0 flex-1 md:block">
              <label className="relative block max-w-sm">
                <span className="sr-only">Search the school</span>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20.5 20.5 16.7 16.7" />
                </svg>
                <input
                  type="search"
                  name="q"
                  placeholder="Search a pupil, receipt or invoice"
                  className="w-full rounded-full border border-hairline bg-slate-100 py-2 pl-9 pr-3.5 text-sm outline-none transition focus:border-brand-500/40 focus:bg-surface focus:ring-4 focus:ring-brand-500/12"
                />
              </label>
            </form>
          ) : null}

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-bold text-slate-900">{auth.name}</p>
              <p className="text-xs text-slate-500">{auth.roles.map(roleLabel).join(" · ")}</p>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-xs font-extrabold text-brand-ink ring-1 ring-hairline">
              {initials}
            </div>
            <ThemeToggle className="print:hidden" />
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

        {auth.subscription.notice ? (
          /* Above the page rather than in a corner: a refused save is a confusing
             thing to meet with no explanation, so the explanation arrives first. */
          <div
            role="status"
            className={`border-b px-4 py-2.5 text-sm lg:px-7 print:hidden ${
              auth.subscription.readOnly
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-amber-200 bg-amber-50 text-amber-700"
            }`}
          >
            {auth.subscription.notice}
          </div>
        ) : null}

        <main className="min-w-0 flex-1 space-y-1 p-4 lg:px-7 lg:py-6 print:p-0">{children}</main>
      </div>
    </div>
  );
}

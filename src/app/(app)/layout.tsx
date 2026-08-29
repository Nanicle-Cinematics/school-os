import { requireAuth } from "@/lib/auth";
import { navFor, roleLabel } from "@/lib/permissions";
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
        <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 lg:px-6 print:hidden">
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

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-bold text-slate-900">{auth.name}</p>
              <p className="text-xs text-slate-500">{auth.roles.map(roleLabel).join(" · ")}</p>
            </div>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-xs font-extrabold text-brand-700">
              {initials}
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

        <main className="min-w-0 flex-1 p-4 lg:p-7 print:p-0">{children}</main>
      </div>
    </div>
  );
}

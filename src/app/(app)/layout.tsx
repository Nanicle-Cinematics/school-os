import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Search } from "lucide-react";
import { requireAuth } from "@/lib/auth";
import { navFor, roleLabel } from "@/lib/permissions";
import { canSearch } from "@/lib/search-data";
import { schoolIconUrls } from "@/lib/manifest-data";
import { ThemeToggle } from "../theme-toggle";
import { SkinPicker } from "../skin-picker";
import { logout } from "@/lib/auth-actions";
import { prisma } from "@/lib/prisma";
import { Sidebar, MobileNav, SectionTint, type RailTerm } from "./nav";

/**
 * A signed-in school's own crest, standing in for the generic School OS mark
 * — the browser tab, the iOS home-screen icon, and (via `/api/manifest`) the
 * Android install prompt all read from here.
 *
 * A school with no crest returns `{}`, same as `paperWatermark()` returns
 * `{}` for a document with none: the root layout's generic mark shows through
 * untouched rather than this layer having to know what the default looks like.
 */
export async function generateMetadata(): Promise<Metadata> {
  const auth = await requireAuth();
  const icons = schoolIconUrls(auth.schoolId, auth.schoolCrestUrl);
  if (!icons) {
    return {};
  }
  return {
    manifest: icons.manifest,
    icons: {
      icon: [
        { url: icons.icon192, sizes: "192x192", type: "image/png" },
        { url: icons.icon512, sizes: "512x512", type: "image/png" },
      ],
      apple: [{ url: icons.appleTouch, sizes: "180x180", type: "image/png" }],
    },
  };
}

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
              <p className="truncate text-sm font-semibold text-warning-ink">No current term set</p>
            )}
          </div>

          {showSearch ? (
            <form method="get" action="/search" className="ml-2 hidden min-w-0 flex-1 md:block">
              <label className="relative block max-w-sm">
                <span className="sr-only">Search the school</span>
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                />
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
            {/**
             * ⚠️ `isPlatformAdmin` was loaded on every request and read by
             * NOTHING. The console existed, the flag that opens it existed, and
             * the only way in was typing /admin from memory — a dead field of
             * exactly the kind this codebase keeps finding, with the difference
             * that this one hid a whole screen.
             *
             * Shown only to the handful of people who have the flag, so an
             * ordinary head teacher never sees a door they cannot open.
             */}
            {auth.isPlatformAdmin ? (
              <Link
                href="/admin"
                className="hidden whitespace-nowrap rounded-full border border-hairline px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 sm:inline-flex"
              >
                Nanicle console
              </Link>
            ) : null}
            <SkinPicker className="print:hidden" />
            <ThemeToggle className="print:hidden" />
            <form action={logout}>
              <button
                type="submit"
                /* whitespace-nowrap: at 390px the header ran out of room and
                   broke the label across two lines as "Sign / out", which reads
                   as a squashed page rather than a button. */
                className="whitespace-nowrap rounded-full border border-hairline px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
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
                ? "border-hairline bg-danger-tint text-danger-ink"
                : "border-hairline bg-warning-tint text-warning-ink"
            }`}
          >
            {auth.subscription.notice}
          </div>
        ) : null}

        {/* SectionTint sets two CSS variables and renders `display: contents`,
            so it colours what is inside without adding a box to the layout. */}
        <main className="min-w-0 flex-1 space-y-1 p-4 lg:px-7 lg:py-6 print:p-0">
          <SectionTint>{children}</SectionTint>
        </main>
      </div>
    </div>
  );
}

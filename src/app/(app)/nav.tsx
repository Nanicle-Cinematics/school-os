"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { bestHrefMatch, sectionFor } from "@/lib/permissions";
import type { NavHue, NavIcon, NavSection } from "@/lib/permissions";

/**
 * The rail is icon-first: at a glance a head teacher is looking for a shape,
 * not reading a list. Stroke icons on a 24 grid, one weight, so they stay even
 * against the dark ground.
 */
const PATHS: Record<NavIcon, string> = {
  dashboard:
    '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
  students:
    '<path d="M17 20v-1.8a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20"/><circle cx="10" cy="7" r="3.6"/><path d="M21 20v-1.8a4 4 0 0 0-3-3.85"/>',
  guardians:
    '<path d="M20.5 5.5a4.6 4.6 0 0 0-6.5 0L12 7.4l-2-1.9a4.6 4.6 0 1 0-6.5 6.5l8.5 8.4 8.5-8.4a4.6 4.6 0 0 0 0-6.5z"/>',
  staff:
    '<rect x="2.5" y="7" width="19" height="13.5" rx="2.5"/><path d="M8.5 7V5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2"/><path d="M2.5 12.5h19"/>',
  houses: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9.6V20.5h13V9.6"/><path d="M10 20.5v-6h4v6"/>',
  classes:
    '<path d="M12 3.5 22 8l-10 4.5L2 8z"/><path d="M6 10.4V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.6"/>',
  subjects:
    '<path d="M4 19.2A2.4 2.4 0 0 1 6.4 16.8H20"/><path d="M6.4 2.5H20v19H6.4A2.4 2.4 0 0 1 4 19.1V4.9a2.4 2.4 0 0 1 2.4-2.4z"/>',
  sheet:
    '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18M9 9v12"/><path d="M13 13.5h4M13 17h4"/>',
  assessments:
    '<path d="M8.5 3.5h7a1.5 1.5 0 0 1 1.5 1.5v0a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 5v0a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M17 5h1.5A1.5 1.5 0 0 1 20 6.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5v-13A1.5 1.5 0 0 1 5.5 5H7"/><path d="M8.5 12l2 2 4.5-4.5"/>',
  results: '<path d="M3 3v18h18"/><path d="M7.5 14.5l3.5-4 3 2.6 4.5-6"/>',
  remarks:
    '<path d="M20.5 11.6a8 8 0 0 1-8.6 8 8.3 8.3 0 0 1-3.6-.85L3.5 20.2l1.45-4.2A8 8 0 0 1 11.9 3.6a8 8 0 0 1 8.6 8z"/>',
  promotions: '<path d="M12 19.5V5"/><path d="M6 11l6-6 6 6"/>',
  fees: '<path d="M6 4.5h9a4 4 0 0 1 0 8H6"/><path d="M4 8.5h10M4 12h10"/><path d="M6 12l7 7.5"/>',
  invoices:
    '<path d="M5.5 3h13v18l-3-2-2 2-2-2-2 2-2-2-2 2z"/><path d="M9 8.5h6M9 12.5h6"/>',
  payments:
    '<rect x="2.5" y="5.5" width="19" height="13" rx="3"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  expenses:
    '<path d="M3.5 6.5h17v12a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M7.5 6.5V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v1.5"/><path d="M9.5 13h5"/>',
  messages:
    '<path d="M21 15a2.5 2.5 0 0 1-2.5 2.5H8L3 21V5.5A2.5 2.5 0 0 1 5.5 3h13A2.5 2.5 0 0 1 21 5.5z"/>',
  users:
    '<circle cx="9" cy="8" r="3.6"/><path d="M15.5 20v-1.8a4 4 0 0 0-4-4h-5a4 4 0 0 0-4 4V20"/><path d="M17.5 8.5h5M20 6v5"/>',
  export:
    '<path d="M12 3v11"/><path d="M8.5 10.5 12 14l3.5-3.5"/><path d="M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/>',
  settings:
    '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9z"/>',
};

function Icon({ name, className }: { name: NavIcon; className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}

/**
 * The tint each area of the app wears, as whole class strings.
 *
 * Written out rather than built with `bg-hue-${hue}-50`: Tailwind scans source
 * text for class names it can see, so an interpolated one is never generated
 * and every chip arrives transparent. The compiler keeps this honest — `Record`
 * over `NavHue` means a new area fails the build rather than the eye.
 */
const HUE: Record<NavHue, string> = {
  overview: "bg-hue-overview-50 text-hue-overview-600",
  people: "bg-hue-people-50 text-hue-people-600",
  academics: "bg-hue-academics-50 text-hue-academics-600",
  finance: "bg-hue-finance-50 text-hue-finance-600",
  school: "bg-hue-school-50 text-hue-school-600",
};

/**
 * The area's colour, handed to the page as two CSS variables.
 *
 * The hue told you which part of the school you were in and then abandoned you
 * at the click: the rail was coloured, the page was not. This carries it
 * through — but as VARIABLES rather than as classes, so the page decides where
 * a tint is useful instead of every component learning about areas.
 *
 * ⚠️ The values are themselves `var(--color-hue-…)`, not literal colours. That
 * is what keeps a tinted page honest in the dark: the variable re-resolves under
 * `html.dark` exactly like every other token, so nothing here needs a second
 * value or a `dark:` class.
 *
 * A path outside the rail — /account/password, a stub — simply gets no tint,
 * and everything that reads these falls back to its neutral.
 */
const TINT: Record<NavHue, Record<string, string>> = {
  overview: {
    "--section-tint": "var(--color-hue-overview-50)",
    "--section-ink": "var(--color-hue-overview-600)",
    "--section-band": "var(--color-hue-overview-band)",
  },
  people: {
    "--section-tint": "var(--color-hue-people-50)",
    "--section-ink": "var(--color-hue-people-600)",
    "--section-band": "var(--color-hue-people-band)",
  },
  academics: {
    "--section-tint": "var(--color-hue-academics-50)",
    "--section-ink": "var(--color-hue-academics-600)",
    "--section-band": "var(--color-hue-academics-band)",
  },
  finance: {
    "--section-tint": "var(--color-hue-finance-50)",
    "--section-ink": "var(--color-hue-finance-600)",
    "--section-band": "var(--color-hue-finance-band)",
  },
  school: {
    "--section-tint": "var(--color-hue-school-50)",
    "--section-ink": "var(--color-hue-school-600)",
    "--section-band": "var(--color-hue-school-band)",
  },
};

export function SectionTint({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const section = sectionFor(pathname);
  return (
    <div
      className="contents"
      style={section ? (TINT[section.hue] as React.CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}

/**
 * The area's icon beside a page title, in the area's own colour.
 *
 * The same chip as the rail item you clicked, which is the point: it is the
 * link between "I pressed the amber thing" and "I am on an amber page".
 */
export function SectionMark() {
  const pathname = usePathname();
  const section = sectionFor(pathname);
  if (!section) {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--section-tint)] text-[var(--section-ink)]"
    >
      <Icon name={section.icon} className="h-[19px] w-[19px]" />
    </span>
  );
}

export type RailTerm = {
  label: string;
  closes: string | null;
  daysLeft: number | null;
};

function NavLinks({ sections, onNavigate }: { sections: NavSection[]; onNavigate?: () => void }) {
  const pathname = usePathname();

  // Only the BEST match is active, not every prefix of it. "/assessments/sheet"
  // starts with "/assessments", so a plain prefix test lit both Mark sheet and
  // Assessments at once — which reads as the app not knowing where you are.
  const activeHref = bestHrefMatch(
    pathname,
    sections.flatMap((section) => section.items.map((item) => item.href)),
  );

  return (
    <nav className="space-y-4">
      {sections.map((section) => (
        <div key={section.heading}>
          <p className="mb-1 px-3 text-[10px] font-extrabold uppercase tracking-[0.13em] text-slate-400">
            {section.heading}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = item.href === activeHref;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    /* One UI's active row is a filled PILL, not a tinted strip
                       with a marker beside it. It is the only fully rounded
                       thing in the rail, which is what makes it findable at a
                       glance without any colour of its own. */
                    className={`flex items-center gap-3 rounded-full py-1 pl-1 pr-3 text-sm transition ${
                      active
                        ? "bg-surface font-bold text-slate-900 shadow-card"
                        : "font-medium text-slate-600 hover:bg-surface/60"
                    }`}
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${HUE[section.hue]}`}
                    >
                      <Icon name={item.icon} className="h-[15px] w-[15px]" />
                    </span>
                    <span className="truncate">{item.label}</span>
                    {item.stub ? (
                      <span className="ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-400">
                        Soon
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The one thing worth a permanent corner: how long is left, and what is unfinished. */
function TermCard({ term }: { term: RailTerm | null }) {
  if (!term) {
    return (
      <div className="rounded-card bg-surface p-3.5 shadow-card">
        <p className="text-[11px] font-bold text-accent-600">No current term</p>
        <p className="mt-0.5 text-[13px] font-bold text-slate-900">Set one in Settings</p>
        <p className="mt-1 text-[11px] text-slate-500">
          Invoices, marks and the dashboard all read it.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-card bg-surface px-3.5 py-3 shadow-card">
      <p className="text-[11px] font-bold text-accent-600">{term.label}</p>
      {term.closes ? (
        <p className="mt-0.5 text-[13px] font-bold text-slate-900">
          Closes {term.closes}
          {term.daysLeft !== null && term.daysLeft >= 0 ? ` · ${term.daysLeft} days` : ""}
        </p>
      ) : (
        <p className="mt-0.5 text-[13px] font-bold text-slate-900">No closing date set</p>
      )}
    </div>
  );
}

function RailBody({
  sections,
  school,
  term,
  onNavigate,
}: {
  sections: NavSection[];
  school: { name: string; shortName: string | null };
  term: RailTerm | null;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="mb-4 flex items-center gap-2.5 px-1.5">
        {/* The one saturated thing in the rail. With the panel now light, the
            school's own mark is what carries the brand that the dark green
            gradient used to — one small solid green square instead of a wall
            of it. */}
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-brand-700 text-[12px] font-extrabold text-white shadow-pill">
          {(school.shortName ?? school.name).slice(0, 2).toUpperCase()}
        </span>
        {/* Two lines rather than an ellipsis: a school's name is the one string
            here that must never be cut off — "St. Mary's Preparator…" is not a
            school. */}
        <span className="min-w-0 text-[13.5px] font-extrabold leading-[1.15] tracking-tight text-slate-900">
          {school.name}
        </span>
      </div>
      {/**
       * The term card scrolls WITH the links rather than being pinned to the
       * floor of the rail.
       *
       * Pinned, it cost twice. A rail taller than its links left a stretch of
       * empty panel between the last item and the card — the thing that looked
       * broken — and on a laptop it also held ~90px hostage while the links
       * themselves were the thing overflowing.
       *
       * It is not a loss, because the term is ALREADY permanent: the header
       * carries "First Term · 2026/2027" on every screen. What the card adds is
       * the closing date and the countdown, which are worth a glance, not a
       * reserved corner.
       */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <NavLinks sections={sections} onNavigate={onNavigate} />
        <div className="mt-3">
          <TermCard term={term} />
        </div>
      </div>
    </>
  );
}

export function Sidebar({
  sections,
  school,
  term,
}: {
  sections: NavSection[];
  school: { name: string; shortName: string | null };
  term: RailTerm | null;
}) {
  return (
    /* Frosted, not filled. `bg-rail` carries its own alpha and inverts with the
       slate ramp, so this is pale glass by day and near-black glass by night
       without a single `dark:` class — the same bet the palette makes. */
    /**
     * ⚠️ `sticky top-0 h-dvh`, not a plain flex child.
     *
     * The rail is a child of `flex min-h-full`, so it stretched to the height of
     * the DOCUMENT: on a long dashboard the links sat at the top, the term card
     * was pushed to the bottom of the page, and the gap between them was however
     * far you had to scroll. Both references pin a sidebar to the VIEWPORT and
     * scroll only its own contents, which is also what makes the term card worth
     * its permanent corner — it is no longer permanently out of sight.
     */
    <aside className="sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col border-r border-hairline bg-rail p-3 backdrop-blur-xl lg:flex print:lg:hidden">
      <RailBody sections={sections} school={school} term={term} />
    </aside>
  );
}

export function MobileNav({
  sections,
  school,
  term,
}: {
  sections: NavSection[];
  school: { name: string; shortName: string | null };
  term: RailTerm | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="rounded-control border border-hairline bg-surface p-2 text-slate-600 shadow-card"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-slate-900/25 backdrop-blur-sm"
          />
          <div className="relative flex w-[276px] flex-col border-r border-hairline bg-rail p-3 backdrop-blur-xl">
            <RailBody
              sections={sections}
              school={school}
              term={term}
              onNavigate={() => setOpen(false)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

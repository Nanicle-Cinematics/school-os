"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { NavIcon, NavSection } from "@/lib/permissions";

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
  const activeHref = sections
    .flatMap((section) => section.items.map((item) => item.href))
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <nav className="space-y-5">
      {sections.map((section) => (
        <div key={section.heading}>
          <p className="mb-1.5 px-3 text-[10px] font-extrabold uppercase tracking-[0.13em] text-white/35">
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
                    className={`relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition ${
                      active
                        ? "bg-surface/[0.13] font-bold text-white"
                        : "font-medium text-white/70 hover:bg-surface/[0.07] hover:text-white"
                    }`}
                  >
                    {active ? (
                      <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-accent-500" />
                    ) : null}
                    <Icon
                      name={item.icon}
                      className={`h-[18px] w-[18px] shrink-0 ${active ? "text-accent-400" : "text-white/55"}`}
                    />
                    <span className="truncate">{item.label}</span>
                    {item.stub ? (
                      <span className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white/45">
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
      <div className="rounded-2xl bg-surface/[0.07] p-3.5">
        <p className="text-[11px] font-bold text-accent-400">No current term</p>
        <p className="mt-0.5 text-[13px] font-bold text-white">Set one in Settings</p>
        <p className="mt-1 text-[11px] text-white/55">
          Invoices, marks and the dashboard all read it.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-2xl bg-surface/[0.07] p-3.5">
      <p className="text-[11px] font-bold text-accent-400">{term.label}</p>
      {term.closes ? (
        <p className="mt-0.5 text-[13px] font-bold text-white">
          Closes {term.closes}
          {term.daysLeft !== null && term.daysLeft >= 0 ? ` · ${term.daysLeft} days` : ""}
        </p>
      ) : (
        <p className="mt-0.5 text-[13px] font-bold text-white">No closing date set</p>
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
      <div className="mb-4 flex items-center gap-2.5 px-1">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface/[0.14] text-[12px] font-extrabold text-white">
          {(school.shortName ?? school.name).slice(0, 2).toUpperCase()}
        </span>
        {/* Two lines rather than an ellipsis: a school's name is the one string
            here that must never be cut off — "St. Mary's Preparator…" is not a
            school. */}
        <span className="min-w-0 text-[13.5px] font-extrabold leading-[1.15] tracking-tight text-white">
          {school.name}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <NavLinks sections={sections} onNavigate={onNavigate} />
      </div>
      <div className="mt-4">
        <TermCard term={term} />
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
    <aside className="hidden w-[236px] shrink-0 flex-col bg-linear-to-b from-brand-800 to-brand-900 p-3.5 lg:flex print:lg:hidden">
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
        className="rounded-lg border border-slate-200 p-2 text-slate-600"
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
            className="absolute inset-0 bg-brand-900/50"
          />
          <div className="relative flex w-[264px] flex-col bg-linear-to-b from-brand-800 to-brand-900 p-3.5">
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

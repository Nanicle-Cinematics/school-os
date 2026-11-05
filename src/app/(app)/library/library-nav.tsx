import Link from "next/link";

const TABS = [
  { href: "/library", label: "Overview" },
  { href: "/library/desk", label: "Lend and return" },
  { href: "/library/books", label: "Books" },
  { href: "/library/loans", label: "Out now" },
  { href: "/library/import", label: "Add from a spreadsheet" },
  { href: "/library/settings", label: "Rules" },
] as const;

/** The library's own tabs, the same pills the admissions queue uses. */
export function LibraryNav({ current }: { current: (typeof TABS)[number]["href"] }) {
  return (
    <nav aria-label="Library" className="flex flex-wrap gap-2">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.href === current ? "page" : undefined}
          className={`rounded-full border px-3 py-1.5 text-sm transition ${
            tab.href === current ? "border-brand-600 bg-brand-600 text-white" : "border-hairline bg-surface text-slate-700 hover:bg-slate-100"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

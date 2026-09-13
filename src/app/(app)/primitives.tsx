import React from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./button-style";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { CircleAlert, Clock, CircleCheck, Info } from "lucide-react";

/**
 * The pieces every page is built from.
 *
 * Kept apart from `ui.tsx` on purpose: that file grew as a bag of helpers, half
 * components and half class strings, and a screen could reach for either. These
 * are the ones a page is *expected* to use, so "is there a primitive for this?"
 * has one place to look.
 *
 * ⚠️ The colour rule this file enforces. Five AREA hues say where you are and
 * live only on the rail and the page-title chip. Four SEVERITIES say what
 * blocks work, and everything here that reports a state takes its colour from
 * those — never from the area, or amber would mean both "Finance" and "due
 * soon" and therefore neither.
 */

/* ───────────────────────────── severity ───────────────────────────── */

/**
 * What a thing's colour is claiming, in the order it interrupts you.
 *
 * `blocking` — somebody cannot do their job until this is dealt with.
 * `soon`     — it runs out shortly; nothing is broken yet.
 * `pending`  — waiting on a person, entirely routine.
 * `done`     — finished, shown only where "finished" is the news.
 * `neutral`  — a plain count with no state at all. The default, and the one
 *              most numbers should be: a roll of 44 pupils is not good or bad.
 */
export type Severity = "blocking" | "soon" | "pending" | "done" | "neutral";

const SEVERITY: Record<Severity, { chip: string; ink: string; icon: LucideIcon }> = {
  blocking: { chip: "bg-danger-tint", ink: "text-danger-ink", icon: CircleAlert },
  soon: { chip: "bg-warning-tint", ink: "text-warning-ink", icon: Clock },
  pending: { chip: "bg-info-tint", ink: "text-info-ink", icon: Info },
  done: { chip: "bg-success-tint", ink: "text-success-ink", icon: CircleCheck },
  neutral: { chip: "bg-slate-100", ink: "text-slate-500", icon: Info },
};

/* ───────────────────────────── buttons ───────────────────────────── */

/**
 * ⚠️ ONE primary per screen.
 *
 * The primary style was pasted verbatim nineteen times across the app while
 * `ButtonLink` had four uses, so screens ended up with three filled green
 * buttons of equal weight and no main action. Filled means "this is the thing
 * to do here"; everything else — including a row of equal actions — is ghost.
 */
export function Button({
  variant = "secondary",
  size = "md",
  icon: IconGlyph,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
}) {
  return (
    <button className={buttonClass(variant, size, className)} {...rest}>
      {IconGlyph ? <IconGlyph className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant = "secondary",
  size = "md",
  icon: IconGlyph,
  className,
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)}>
      {IconGlyph ? <IconGlyph className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
      {children}
    </Link>
  );
}

/* ───────────────────────────── stat card ───────────────────────────── */

/**
 * A number, with an icon that means something or nothing.
 *
 * ⚠️ `severity` defaults to neutral and should USUALLY stay there. Most figures
 * on these screens are plain counts — 44 pupils, 9 staff, 11 classes — and
 * colouring them makes a dashboard where everything is urgent, which is a
 * dashboard where nothing is. Reach for a severity only when the number itself
 * reports a state: money owed, marks outstanding.
 */
export function StatCard({
  label,
  value,
  caption,
  icon: IconGlyph,
  severity = "neutral",
  progress,
  hero = false,
}: {
  label: string;
  value: string;
  caption?: string;
  icon: LucideIcon;
  severity?: Severity;
  /** 0–100. A bar under the number, for "x of y" figures. */
  progress?: number;
  /** The one figure on the screen that decides what happens next. */
  hero?: boolean;
}) {
  const tone = SEVERITY[severity];
  return (
    <div
      className={`rounded-card border border-hairline bg-surface p-card shadow-card ${
        hero ? "lg:col-span-2" : ""
      }`}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tone.chip} ${tone.ink}`}
        >
          <IconGlyph className="h-[17px] w-[17px]" />
        </span>
        <p className="min-w-0 truncate text-caption font-medium text-slate-500">{label}</p>
      </div>

      <p
        className={`font-heading mt-3 leading-none tabular-nums ${
          value.length > 10 ? "text-[18px] sm:text-[22px]" : "text-[22px] sm:text-[26px]"
        } ${hero ? "lg:text-[38px]" : "lg:text-[30px]"} ${
          severity === "neutral" ? "text-slate-900" : tone.ink
        }`}
      >
        {value}
      </p>

      {progress !== undefined ? (
        <span className="mt-3 block h-2 overflow-hidden rounded-full bg-slate-100">
          <span
            className="block h-full rounded-full bg-brand-600"
            style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
          />
        </span>
      ) : null}

      {caption ? <p className="mt-2 text-caption text-slate-500">{caption}</p> : null}
    </div>
  );
}

/* ───────────────────────────── list row ───────────────────────────── */

/**
 * One line of "somebody needs to do something", with the colour earned.
 *
 * ⚠️ The severity comes from what BLOCKS WORK, not from the topic and not from
 * the position in the list. The dashboard used to colour these by subject —
 * fees red, marking blue, results green — so an overdue invoice and a
 * first-week reminder looked identical, and a school with nothing wrong still
 * showed a red dot.
 */
export function ListRow({
  title,
  subtitle,
  severity = "pending",
  icon: IconGlyph,
  href,
  action,
}: {
  title: string;
  subtitle?: string;
  severity?: Severity;
  /** Defaults to the severity's own glyph, which is usually the right one. */
  icon?: LucideIcon;
  href?: string;
  action?: { label: string; href: string };
}) {
  const tone = SEVERITY[severity];
  const Glyph = IconGlyph ?? tone.icon;

  const body = (
    <>
      <span
        aria-hidden="true"
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tone.chip} ${tone.ink}`}
      >
        <Glyph className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-semibold text-slate-900 lg:truncate">{title}</span>
        {subtitle ? (
          <span className="mt-0.5 block text-caption text-slate-500 lg:truncate">{subtitle}</span>
        ) : null}
      </span>
    </>
  );

  return (
    <li className="border-b border-hairline last:border-b-0">
      <div className="flex items-center gap-3.5 px-card py-3.5">
        {href ? (
          <Link href={href} className="flex min-w-0 flex-1 items-center gap-3.5 hover:opacity-80">
            {body}
          </Link>
        ) : (
          body
        )}
        {action ? (
          <ButtonLink href={action.href} variant="ghost" size="sm">
            {action.label}
          </ButtonLink>
        ) : null}
      </div>
    </li>
  );
}

/* ───────────────────────────── empty state ───────────────────────────── */

/**
 * What a screen says when there is nothing yet.
 *
 * ⚠️ Three parts, all required except the action: an icon, ONE line saying why
 * it is empty, and the thing to press. A blank table reads as a broken page —
 * and an office that thinks the software is broken stops trusting the figures
 * on the screens that are working.
 */
export function EmptyState({
  icon: IconGlyph,
  title,
  action,
}: {
  icon: LucideIcon;
  title: string;
  action?: { label: string; href: string };
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-card py-12 text-center">
      <span
        aria-hidden="true"
        className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400"
      >
        <IconGlyph className="h-5 w-5" />
      </span>
      <p className="max-w-sm text-body text-slate-500">{title}</p>
      {action ? (
        <ButtonLink href={action.href} variant="primary" size="sm">
          {action.label}
        </ButtonLink>
      ) : null}
    </div>
  );
}

/* ───────────────────────────── data table ───────────────────────────── */

export type Column = {
  /** Sentence case. The uppercase habit is what this pass is removing. */
  label: string;
  /** Right-align a money or count column. */
  numeric?: boolean;
  /** Hide below this breakpoint, so a phone sheds columns instead of scrolling. */
  hideBelow?: "sm" | "md" | "lg";
};

const HIDE = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
} as const;

/** The same class the header uses, so a row's cells line up with it. */
export function cellClass(column: Column) {
  // `text-left` explicitly: a bare <th> centres, and the old tables got their
  // alignment from a `text-left` on the <table> that this wrapper does not
  // carry — so every header sat centred over a left-aligned column.
  return `px-card py-2.5 ${column.numeric ? "text-right tabular-nums" : "text-left"} ${
    column.hideBelow ? HIDE[column.hideBelow] : ""
  }`.trim();
}

/**
 * Every list on every screen, in one shape.
 *
 * Thirty files assembled their own `<table>` — twenty-five shared the header
 * class and five did not, so the same list of people looked different depending
 * which page you opened it from. This owns the header, the hover, the overflow
 * and the empty state; a page supplies columns and rows.
 *
 * ⚠️ `empty` is REQUIRED. A table with no rows was the commonest silent failure
 * here: it renders a header and a void, which reads as a page that broke rather
 * than a school that has not added anyone yet. Making it part of the type means
 * a new list cannot ship without one.
 */
export function DataTable({
  columns,
  empty,
  children,
}: {
  columns: Column[];
  empty: { icon: LucideIcon; title: string; action?: { label: string; href: string } } | null;
  children: React.ReactNode;
}) {
  const rows = React.Children.count(children);
  return (
    <section className="overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
      {rows === 0 && empty ? (
        <EmptyState icon={empty.icon} title={empty.title} action={empty.action} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-body">
            <thead>
              {/* The area's own tint, and the one place a page wears it. */}
              <tr className="border-b border-hairline bg-[var(--section-band,var(--color-slate-50))] text-caption text-slate-500">
                {columns.map((column) => (
                  <th
                    key={column.label}
                    scope="col"
                    className={`${cellClass(column)} font-semibold`}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">{children}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A row, with the hover every list should have had. */
export function Row({ children }: { children: React.ReactNode }) {
  return <tr className="transition hover:bg-slate-50">{children}</tr>;
}

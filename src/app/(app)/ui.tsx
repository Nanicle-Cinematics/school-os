import Link from "next/link";
import { buttonClass } from "./button-style";
import { SectionMark } from "./nav";

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  /**
   * One UI's signature: a LARGE title with air around it.
   *
   * The old 24px heading sat the same distance from the content as a card title
   * did, so a screen opened with three things competing to be read first. This
   * is big enough that nothing argues with it, and the subtitle underneath is
   * the only thing allowed near it.
   */
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-0.5 pb-1 pt-1">
      <div className="min-w-0">
        <SectionMark />
        <h1 className="font-heading text-[31px] leading-[1.1] text-slate-900">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1.5 text-[13.5px] text-slate-500">{subtitle}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/**
 * `Stat` is gone. Every summary figure goes through `StatCard` in
 * primitives.tsx, which requires an icon and takes a SEVERITY rather than a
 * decorative tone — keeping both would let a page pick the one with no rules
 * attached, which is how the old labels stayed uppercase.
 */

export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-card border border-hairline bg-surface shadow-card">
      {title ? (
        <div className="flex items-center justify-between border-b border-hairline px-4.5 py-4">
          <h2 className="text-[14.5px] font-extrabold tracking-tight text-slate-900">
            {title}
          </h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-xs text-slate-400">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * A field, One UI-shaped: a filled well rather than an outlined box.
 *
 * The border does the separating in a light UI and the fill does it here, which
 * is why the resting state is `bg-slate-100` with a hairline and the focus state
 * lifts to the surface colour. Taller too — these are tapped on phones by a
 * bursar standing at a window, not only clicked with a mouse.
 */
export const inputClass =
  "w-full rounded-control border border-hairline bg-slate-100 px-3.5 py-2.5 text-sm outline-none transition focus:border-brand-500/40 focus:bg-surface focus:ring-4 focus:ring-brand-500/12";

/**
 * The same field without the width, for inline filter rows.
 *
 * `inputClass` is `w-full`, and Tailwind orders utilities by its own rules
 * rather than by the order you write them — so a `w-44` set beside it silently
 * lost, and every filter row on every list screen stacked one control per line.
 */
export const filterClass = inputClass.replace("w-full ", "");

export function Alert({
  tone,
  children,
}: {
  tone: "error" | "success";
  children: React.ReactNode;
}) {
  return (
    <p
      role="alert"
      className={`rounded-control px-3.5 py-2.5 text-sm ${
        tone === "error"
          ? "bg-red-50 text-red-700"
          : "bg-green-50 text-green-700"
      }`}
    >
      {children}
    </p>
  );
}

const STATUS_TONE: Record<string, string> = {
  PAID: "bg-green-50 text-green-700",
  PARTIALLY_PAID: "bg-amber-50 text-amber-700",
  ISSUED: "bg-blue-50 text-blue-700",
  OVERDUE: "bg-red-50 text-red-700",
  DRAFT: "bg-slate-100 text-slate-500",
  CANCELLED: "bg-slate-100 text-slate-400 line-through",
  CONFIRMED: "bg-green-50 text-green-700",
  REVERSED: "bg-red-50 text-red-700 line-through",
  PENDING: "bg-amber-50 text-amber-700",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-extrabold ${
        STATUS_TONE[status] ?? "bg-slate-100 text-slate-500"
      }`}
    >
      {status.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

export function ButtonLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={buttonClass("primary")}
    >
      {children}
    </Link>
  );
}

export function EmptyRow({
  colSpan,
  children,
}: {
  colSpan: number;
  children: React.ReactNode;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-4 py-10 text-center text-sm text-slate-500"
      >
        {children}
      </td>
    </tr>
  );
}

export const thClass = "px-4 py-2.5 font-extrabold";
/**
 * The one structural place the area's colour earns its keep on a page.
 *
 * A list screen has exactly one of these, it sits above everything you are
 * about to read, and it is already a flat grey band — so tinting it costs
 * nothing and says "Finance" for as long as you are scanning the table.
 *
 * It reads `--section-band`, not `--section-tint`: the chip's value is sized for
 * a 28px circle and is far too present stretched across a full-width header.
 *
 * The fallback matters: `var(--section-band, …)` keeps the old grey on any page
 * outside the rail, so nothing turns transparent when the variable is absent.
 */
export const tableHeadClass =
  "border-b border-hairline bg-[var(--section-band,var(--color-slate-50))] text-[10.5px] uppercase tracking-[0.11em] text-slate-500";

/**
 * Initials in a tinted square. Rows about a person read faster with a fixed
 * anchor on the left than with a wall of names, and a school has no photographs
 * to put there.
 */
export function Avatar({
  firstName,
  lastName,
  size = "md",
}: {
  firstName: string;
  lastName: string;
  size?: "sm" | "md";
}) {
  const initials =
    `${firstName.at(0) ?? ""}${lastName.at(0) ?? ""}`.toUpperCase();
  const box =
    size === "sm"
      ? "h-8 w-8 rounded-full text-[11px]"
      : "h-9 w-9 rounded-full text-[12px]";
  return (
    <span
      aria-hidden="true"
      className={`${box} flex shrink-0 items-center justify-center bg-brand-50 font-extrabold text-brand-ink`}
    >
      {initials}
    </span>
  );
}

/**
 * A mark out of 100, coloured by where it falls. A teacher scanning a column
 * wants to see who is struggling without reading a single number.
 */
export function ScoreBadge({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-sm text-slate-300">—</span>;
  }
  const tone =
    value >= 70
      ? "bg-brand-50 text-brand-ink"
      : value >= 50
        ? "bg-accent-50 text-accent-700"
        : "bg-red-50 text-red-600";
  return (
    <span
      className={`inline-block min-w-[3.25rem] rounded-full px-2.5 py-1 text-center text-sm font-extrabold tabular-nums ${tone}`}
    >
      {value.toFixed(1)}
    </span>
  );
}

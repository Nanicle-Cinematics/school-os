import Link from "next/link";
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
        <h1 className="font-heading text-[31px] leading-[1.1] text-slate-900">{title}</h1>
        {subtitle ? <p className="mt-1.5 text-[13.5px] text-slate-500">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "default",
  trend,
  hero = false,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "positive" | "negative" | "attention";
  /** A period-on-period movement, shown as a chip beside the label. */
  trend?: { value: string; up: boolean };
  /**
   * The one figure on the screen that decides what happens next: wider, and
   * printed larger. Used sparingly — a row where every tile is a hero is a row
   * with no hero, which is what four identical tiles already were.
   */
  hero?: boolean;
}) {
  const toneClass =
    tone === "positive"
      ? "text-brand-ink"
      : tone === "negative"
        ? "text-red-600"
        : tone === "attention"
          ? "text-accent-600"
          : "text-slate-900";
  return (
    <div
      /**
       * ⚠️ `lg:col-span-2`, never a bare `col-span-2`.
       *
       * The phone grid is two columns wide, so spanning both there does not make
       * the hero bigger — it makes it a full-width row, and the tile before it is
       * left sitting beside a hole. On a phone the gold already does the job the
       * extra width does on a laptop.
       */
      className={`rounded-card border border-hairline bg-surface p-4.5 shadow-card ${
        hero ? "lg:col-span-2" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10.5px] font-extrabold uppercase tracking-[0.11em] text-slate-400">
          {label}
        </p>
        {trend ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-extrabold ${
              trend.up ? "bg-brand-50 text-brand-ink" : "bg-red-50 text-red-600"
            }`}
          >
            {trend.up ? "↑" : "↓"} {trend.value}
          </span>
        ) : null}
      </div>
      <p
        /**
         * ⚠️ The figure is sized for the CARD and for ITS OWN LENGTH.
         *
         * A phone splits this row into two ~165px cards, and a figure set at
         * 30px is wider than that — the number ran past its own card and looked
         * clipped. Ghanaian amounts carry a currency mark and a thousands
         * separator, so nine glyphs is the normal case here.
         *
         * Sizing to the card alone was not enough, and I checked only the
         * dashboard when I first did it: /invoices prints pesewas too, so
         * "GH₵50,700.00" is twelve glyphs and overflowed at the smaller size as
         * well. The length is part of the measurement, not a property of one
         * page, so it belongs here rather than in a caller that remembers.
         */
        className={`font-heading mt-2.5 leading-none tabular-nums ${
          value.length > 10 ? "text-[18px] sm:text-[22px]" : "text-[22px] sm:text-[26px]"
        } ${
          hero ? "lg:text-[38px]" : "lg:text-[30px]"
        } ${toneClass}`}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-slate-500">{sub}</p> : null}
    </div>
  );
}

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
          <h2 className="text-[14.5px] font-extrabold tracking-tight text-slate-900">{title}</h2>
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
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-400">{hint}</span> : null}
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

export function Alert({ tone, children }: { tone: "error" | "success"; children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className={`rounded-control px-3.5 py-2.5 text-sm ${
        tone === "error" ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"
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

export function ButtonLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-full bg-brand-600 px-5 py-2.5 text-sm font-bold text-white shadow-pill transition hover:bg-brand-700 active:scale-[0.98]"
    >
      {children}
    </Link>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-slate-500">
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
  const initials = `${firstName.at(0) ?? ""}${lastName.at(0) ?? ""}`.toUpperCase();
  const box =
    size === "sm" ? "h-8 w-8 rounded-full text-[11px]" : "h-9 w-9 rounded-full text-[12px]";
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

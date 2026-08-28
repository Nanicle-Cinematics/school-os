import Link from "next/link";

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl text-slate-900">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p> : null}
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
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "positive" | "negative";
}) {
  const toneClass =
    tone === "positive" ? "text-brand-600" : tone === "negative" ? "text-red-600" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`font-display mt-1.5 text-2xl tabular-nums ${toneClass}`}>{value}</p>
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
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      {title ? (
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
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

export const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-600 focus:ring-1 focus:ring-brand-600";

export function Alert({ tone, children }: { tone: "error" | "success"; children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className={`rounded-lg px-3 py-2 text-sm ${
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
      className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${
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
      className="rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-800"
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

export const thClass = "px-4 py-2.5 font-medium";
export const tableHeadClass =
  "border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500";

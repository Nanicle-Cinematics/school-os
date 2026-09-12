import Link from "next/link";
import { requireGuardian } from "@/lib/portal-auth";
import { getMyChildren } from "@/lib/portal-data";
import { formatCedis } from "@/lib/money";

export const metadata = { title: "My children · School OS" };

function fullName(s: { firstName: string; middleName: string | null; lastName: string }) {
  return [s.firstName, s.middleName, s.lastName].filter(Boolean).join(" ");
}

function initials(s: { firstName: string; lastName: string }) {
  return `${s.firstName[0] ?? ""}${s.lastName[0] ?? ""}`.toUpperCase();
}

export default async function PortalHomePage() {
  const ctx = await requireGuardian();
  const children = await getMyChildren(ctx.studentIds);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-heading text-2xl font-extrabold tracking-tight text-slate-900">
          Good to see you, {ctx.name.split(" ")[0]}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {children.length === 1
            ? "Your child at this school."
            : `Your ${children.length} children at this school.`}
        </p>
      </div>

      {children.length === 0 ? (
        // A guardian record with no children linked. Says who to ask rather than
        // showing an empty page that reads as though the school lost them.
        <div className="rounded-card border border-hairline bg-surface shadow-card p-6 text-center">
          <p className="text-sm font-semibold text-slate-900">No children linked yet</p>
          <p className="mt-1 text-sm text-slate-600">
            The school has not yet linked a pupil to your account. Please ask the
            office to add your child to your record.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {children.map((child) => (
            <li key={child.id}>
              <Link
                href={`/portal/${child.id}`}
                /* Stacks on a handset. Three columns across 390px squeezed the
                   middle one until the class and admission number truncated —
                   "Kindergarten 1 A · S…" — and that line is the whole reason a
                   parent with two children can tell which row is which. */
                className="flex flex-col gap-3 rounded-card border border-hairline bg-surface shadow-card p-4 transition hover:border-brand-300 hover:shadow-sm sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="flex min-w-0 items-center gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-sm font-extrabold text-brand-ink">
                  {initials(child)}
                </div>

                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold text-slate-900">{fullName(child)}</p>
                    <p className="truncate text-sm text-slate-500">
                      {child.currentClassGroup
                        ? `${child.currentClassGroup.level.name} ${child.currentClassGroup.name}`
                        : "No class assigned"}
                      {" · "}
                      {child.admissionNo}
                    </p>
                  </div>
                </div>

                {/* Under the name on a phone, beside it from sm up. */}
                <div className="flex shrink-0 items-baseline gap-2 border-t border-slate-100 pt-3 sm:block sm:border-0 sm:pt-0 sm:text-right">
                  {child.balance && Number(child.balance) > 0 ? (
                    <>
                      <p className="text-xs text-slate-500">Owing</p>
                      <p className="font-bold tabular-nums text-accent-700">
                        {formatCedis(child.balance)}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm font-semibold text-brand-ink">Paid up</p>
                  )}
                  <p className="text-xs text-slate-400 sm:mt-0.5">
                    {child.reportCards === 0
                      ? "No report cards yet"
                      : `${child.reportCards} report card${child.reportCards === 1 ? "" : "s"}`}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

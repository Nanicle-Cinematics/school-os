import Link from "next/link";

type Child = {
  id: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  admissionNo: string;
  status: string;
  currentClassGroup: { name: string; level: { name: string } } | null;
};

/**
 * The name-and-class band every child page carries, with a way back to the
 * children list. Shared so the three portal screens cannot drift apart.
 */
export function ChildHeader({ child }: { child: Child }) {
  const name = [child.firstName, child.middleName, child.lastName].filter(Boolean).join(" ");
  const badge = `${child.firstName[0] ?? ""}${child.lastName[0] ?? ""}`.toUpperCase();

  return (
    <div className="flex items-center gap-4">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-sm font-extrabold text-brand-700">
        {badge}
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="truncate font-heading text-xl font-extrabold tracking-tight text-slate-900">
          {name}
        </h1>
        <p className="truncate text-sm text-slate-500">
          {child.currentClassGroup
            ? `${child.currentClassGroup.level.name} ${child.currentClassGroup.name}`
            : "No class assigned"}
          {" · "}
          {child.admissionNo}
        </p>
      </div>
      <Link
        href="/portal"
        className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
      >
        All children
      </Link>
    </div>
  );
}

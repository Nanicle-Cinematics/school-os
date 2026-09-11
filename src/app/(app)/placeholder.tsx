/**
 * Shell for sections that are navigable but not yet built. Keeps the sidebar
 * honest — every link goes somewhere and says what it will become — instead of
 * dead links or a 404.
 */
export function Placeholder({
  title,
  description,
  phase,
}: {
  title: string;
  description: string;
  phase: string;
}) {
  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-xl border border-dashed border-slate-300 bg-surface p-8 text-center">
        <span className="inline-block rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
          {phase}
        </span>
        <h1 className="mt-3 text-lg font-semibold text-slate-900">{title}</h1>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-500">{description}</p>
      </div>
    </div>
  );
}

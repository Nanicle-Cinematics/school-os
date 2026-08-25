import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { getFeeSetup } from "@/lib/fee-data";
import { deleteFeeStructure } from "@/lib/fee-actions";
import { formatCedis } from "@/lib/money";
import { PageHeader, Card, Stat } from "../ui";
import { SubmitButton } from "../submit-button";
import { StructureForm } from "./structure-form";

export const metadata: Metadata = { title: "Fee structure · School OS" };

export default async function FeesPage() {
  await requireRole(FINANCE);
  const setup = await getFeeSetup();

  if (!setup) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            No academic year is marked as current. Set one up in Settings before creating fee
            structures.
          </p>
        </Card>
      </div>
    );
  }

  const { year, levels, categories, terms, structures } = setup;
  const covered = new Set(structures.map((s) => s.levelId));
  const missing = levels.filter((level) => !covered.has(level.id));

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Fee structure"
        subtitle={`Termly fees for ${year.name}`}
        action={
          <StructureForm
            levels={levels}
            categories={categories}
            terms={terms}
            academicYearId={year.id}
          />
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Structures" value={String(structures.length)} sub={`${levels.length} levels`} />
        <Stat
          label="Levels priced"
          value={`${covered.size}/${levels.length}`}
          tone={missing.length > 0 ? "negative" : "positive"}
          sub={missing.length > 0 ? `${missing.length} missing` : "all covered"}
        />
        <Stat label="Fee items" value={String(categories.length)} />
        <Stat
          label="Highest termly fee"
          value={formatCedis(
            structures.reduce((max, s) => (Number(s.total) > max ? Number(s.total) : max), 0),
          )}
        />
      </div>

      {missing.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-medium">No fee structure yet for:</span>{" "}
          {missing.map((level) => level.name).join(", ")}. Students in these levels will be skipped
          when you generate invoices.
        </div>
      ) : null}

      <div className="space-y-4">
        {structures.length === 0 ? (
          <Card>
            <p className="px-4 py-10 text-center text-sm text-slate-500">
              No fee structures yet. Create one to start invoicing.
            </p>
          </Card>
        ) : (
          structures.map((structure) => (
            <Card
              key={structure.id}
              title={structure.level.name}
              action={
                <div className="flex items-center gap-3">
                  <span className="text-xs text-slate-500">
                    {structure.term ? `Term ${structure.term.sequence}` : "All terms"} ·{" "}
                    {structure.residency === "ANY" ? "day & boarding" : structure.residency.toLowerCase()}
                    {structure.studentType !== "ANY" ? ` · ${structure.studentType.toLowerCase()}` : ""}
                  </span>
                  <form action={deleteFeeStructure}>
                    <input type="hidden" name="structureId" value={structure.id} />
                    <SubmitButton variant="danger" pendingLabel="Removing…">
                      Remove
                    </SubmitButton>
                  </form>
                </div>
              }
            >
              <div className="flex flex-wrap gap-x-8 gap-y-2 px-4 py-3">
                {structure.items.map((item) => (
                  <div key={item.id} className="min-w-32">
                    <p className="text-xs text-slate-500">{item.feeCategory.name}</p>
                    <p className="text-sm font-medium tabular-nums text-slate-900">
                      {formatCedis(item.amount)}
                    </p>
                  </div>
                ))}
                <div className="ml-auto min-w-32 border-l border-slate-100 pl-6">
                  <p className="text-xs font-medium uppercase text-slate-500">Total per term</p>
                  <p className="text-base font-semibold tabular-nums text-slate-900">
                    {formatCedis(structure.total)}
                  </p>
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

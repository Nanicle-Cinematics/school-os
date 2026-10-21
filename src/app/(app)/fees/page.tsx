import type { Metadata } from "next";
import { StatCard } from "../primitives";
import { Layers, Receipt, TrendingUp } from "lucide-react";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { getFeeSetup } from "@/lib/fee-data";
import { deleteFeeStructure } from "@/lib/fee-actions";
import { formatCedis } from "@/lib/money";
import { PageHeader, Card } from "../ui";
import { buttonClass } from "../button-style";
import { SubmitButton } from "../submit-button";
import { StructureForm } from "./structure-form";
import { FeeItemSection } from "./fee-items";

export const metadata: Metadata = { title: "Fee structure · School OS" };

export default async function FeesPage() {
  await requireRole(FINANCE);
  const setup = await getFeeSetup();

  if (!setup) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            No academic year is marked as current, and fees are priced per term.{" "}
            <Link
              href="/settings/terms"
              className="font-medium text-brand-ink hover:underline"
            >
              Set up the year and its terms
            </Link>{" "}
            first.
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
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/fees/items-to-bring" className={buttonClass("secondary")}>
              Items to bring
            </Link>
            <StructureForm
              levels={levels}
              categories={categories}
              terms={terms}
              academicYearId={year.id}
              pricedLevelIds={[...covered]}
            />
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Structures"
          value={String(structures.length)}
          caption={`${levels.length} levels`}
          icon={Layers}
        />
        <StatCard
          label="Levels priced"
          value={`${covered.size}/${levels.length}`}
          caption={
            missing.length > 0 ? `${missing.length} missing` : "all covered"
          }
          icon={Layers}
        />
        <StatCard
          label="Fee items"
          value={String(categories.length)}
          icon={Receipt}
        />
        <StatCard
          label="Highest termly fee"
          value={formatCedis(
            structures.reduce(
              (max, s) => (Number(s.total) > max ? Number(s.total) : max),
              0,
            ),
          )}
          icon={TrendingUp}
        />
      </div>

      <Card title={`Fee items · ${categories.length}`}>
        <FeeItemSection items={categories} />
      </Card>

      {missing.length > 0 && categories.length > 0 ? (
        <div className="rounded-xl border border-hairline bg-warning-tint px-4 py-3 text-sm text-warning-ink">
          <span className="font-medium">No fee structure yet for:</span>{" "}
          {missing.map((level) => level.name).join(", ")}. Students in these
          levels will be skipped when you generate invoices.
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
                    {structure.term
                      ? `Term ${structure.term.sequence}`
                      : "All terms"}{" "}
                    ·{" "}
                    {structure.residency === "ANY"
                      ? "day & boarding"
                      : structure.residency.toLowerCase()}
                    {structure.studentType !== "ANY"
                      ? ` · ${structure.studentType.toLowerCase()}`
                      : ""}
                  </span>
                  <form action={deleteFeeStructure}>
                    <input
                      type="hidden"
                      name="structureId"
                      value={structure.id}
                    />
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
                    <p className="text-xs text-slate-500">
                      {item.feeCategory.name}
                    </p>
                    <p className="text-sm font-medium tabular-nums text-slate-900">
                      {formatCedis(item.amount)}
                    </p>
                  </div>
                ))}
                <div className="ml-auto min-w-32 border-l border-slate-100 pl-6">
                  <p className="text-xs font-medium text-slate-500">
                    Total per term
                  </p>
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

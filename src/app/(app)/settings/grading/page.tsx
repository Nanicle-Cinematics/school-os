import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getGradingScales, isFrozen } from "@/lib/grading-data";
import { deleteScale, duplicateScale } from "@/lib/grading-actions";
import { Alert, Card } from "../../ui";
import { SubmitButton } from "../../submit-button";
import { BandEditor, NewScaleForm, ScaleNameForm } from "./grading-forms";

export const metadata: Metadata = { title: "Grading scales · School OS" };

export default async function GradingPage() {
  const auth = await requireRole(OFFICE);
  const { scales, defaultScaleId } = await getGradingScales(auth.schoolId);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/settings" className="text-sm text-slate-500 hover:text-slate-900">
            ← Settings
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">Grading scales</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            What a mark means. A scale that has already graded results is locked — duplicate it and
            edit the copy.
          </p>
        </div>
        <NewScaleForm />
      </div>

      {scales.length === 0 ? (
        <Alert tone="error">
          No grading scale exists, so results cannot be graded at all. Create one and give it bands.
        </Alert>
      ) : null}

      {scales.map((scale) => {
        const frozen = isFrozen(scale);
        const isDefault = scale.id === defaultScaleId;
        const covered = scale.bands.length;

        return (
          <Card
            key={scale.id}
            title={`${scale.name}${isDefault ? " · default" : ""}`}
            action={
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">
                  {covered} band{covered === 1 ? "" : "s"}
                  {frozen ? " · in use" : ""}
                </span>
                <form action={duplicateScale}>
                  <input type="hidden" name="id" value={scale.id} />
                  <SubmitButton variant="secondary" pendingLabel="…">
                    Duplicate
                  </SubmitButton>
                </form>
                {!frozen && !isDefault ? (
                  <form action={deleteScale}>
                    <input type="hidden" name="id" value={scale.id} />
                    <SubmitButton variant="danger" pendingLabel="…">
                      Delete
                    </SubmitButton>
                  </form>
                ) : null}
              </div>
            }
          >
            <ScaleNameForm scale={{ id: scale.id, name: scale.name }} isDefault={isDefault} />

            {frozen ? (
              <div className="border-t border-slate-100">
                <div className="overflow-x-auto p-4">
                  <div className="flex flex-wrap gap-1.5">
                    {scale.bands.map((band) => (
                      <span
                        key={band.id}
                        title={`${band.remark} · ${band.points} point${
                          band.points === 1 ? "" : "s"
                        }`}
                        className={`rounded px-1.5 py-0.5 text-xs ${
                          band.isPass ? "bg-slate-100 text-slate-700" : "bg-danger-tint text-danger-ink"
                        }`}
                      >
                        {band.grade} {band.minScore.toString()}–{band.maxScore.toString()}
                      </span>
                    ))}
                  </div>
                </div>
                <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
                  Locked — results have been graded against these bands. Moving a boundary now would
                  change what an already-printed report card claims. Duplicate the scale, edit the
                  copy, and make it the default.
                </p>
              </div>
            ) : (
              <BandEditor
                scaleId={scale.id}
                bands={scale.bands.map((band) => ({
                  id: band.id,
                  grade: band.grade,
                  minScore: band.minScore.toString(),
                  maxScore: band.maxScore.toString(),
                  points: band.points,
                  remark: band.remark,
                  isPass: band.isPass,
                }))}
              />
            )}
          </Card>
        );
      })}

      <p className="text-xs text-slate-400">
        Bands may not overlap — an overlap makes the grade a child receives depend on row order.
        Points are the aggregate weight: A1 = 1 through F9 = 9, and the best-N of them make the BECE
        aggregate set in Settings.
      </p>
    </div>
  );
}

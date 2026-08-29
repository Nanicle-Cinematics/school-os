import type { Collections } from "@/lib/dashboard-data";
import { formatCedis } from "@/lib/dashboard-data";
import { Card } from "../ui";

/** Plot height in pixels — see the note on the bars below. */
const PLOT = 148;

/**
 * Fees collected, by week of the term.
 *
 * One series, so no legend — the card title names it. Every bar is the brand
 * hue; the CURRENT week is picked out in the accent. Deliberately not the
 * biggest week: colour has to follow the entity rather than its rank, or the
 * highlight jumps around as money comes in and stops meaning anything. "Where
 * we are now" is stable and is what a bursar is looking for.
 *
 * Only two values are printed — the current week and the best — because a
 * number on every bar is a table pretending to be a chart. The rest are on
 * hover, and all of them are in the table underneath for anyone who cannot use
 * either.
 */
export function CollectionsChart({
  collections,
  billed,
}: {
  collections: Collections;
  billed: number;
}) {
  const { weeks, total, best } = collections;

  if (weeks.length === 0) {
    return (
      <Card title="Fees collected by week">
        <p className="px-4 py-8 text-center text-sm text-slate-500">
          Nothing collected yet this term. Bars appear as payments are recorded.
        </p>
      </Card>
    );
  }

  return (
    <Card title="Fees collected by week">
      <div className="px-4 pb-4 pt-3">
        <p className="mb-4 text-xs text-slate-500">
          {formatCedis(total)} of {formatCedis(billed)} billed
        </p>

        {/* Bar heights are in PIXELS, not percentages. A percentage height needs a
            parent with a definite height, and inside a flex row with `items-end`
            the columns size to their content — so the first version of this chart
            rendered labels with no bars at all. */}
        <div className="flex items-end gap-2" style={{ height: `${PLOT + 16}px` }}>
          {weeks.map((week) => {
            const label = week.isCurrent || (week.amount === best && best > 0);
            const height = week.amount > 0 ? Math.max(4, Math.round(week.share * PLOT)) : 2;
            return (
              // A term two weeks in should not paint two slabs; the bar is capped
              // and centred so an early chart reads as early, not as a block.
              <div key={week.index} className="flex min-w-0 flex-1 flex-col items-center">
                {label && week.amount > 0 ? (
                  <span
                    className={`mb-1 w-full truncate text-center text-[10px] font-extrabold ${
                      week.isCurrent ? "text-accent-600" : "text-slate-400"
                    }`}
                  >
                    {formatCedis(week.amount)}
                  </span>
                ) : (
                  <span className="mb-1 h-[14px]" />
                )}
                <div
                  title={`${week.label} · ${week.range} · ${formatCedis(week.amount)}`}
                  style={{ height: `${height}px` }}
                  className={`w-full max-w-16 rounded-t-[4px] ${
                    week.amount === 0
                      ? "bg-slate-200"
                      : week.isCurrent
                        ? "bg-accent-500"
                        : "bg-brand-600"
                  }`}
                />
              </div>
            );
          })}
        </div>

        <div className="mt-2 flex gap-2">
          {weeks.map((week) => (
            <span
              key={week.index}
              className={`min-w-0 flex-1 truncate text-center text-[10.5px] ${
                week.isCurrent ? "font-extrabold text-slate-700" : "text-slate-400"
              }`}
            >
              {week.label}
            </span>
          ))}
        </div>
      </div>

      {/* The same figures, for a screen reader or anyone the bars fail. */}
      <table className="sr-only">
        <caption>Fees collected by week of the term</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Dates</th>
            <th scope="col">Collected</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.index}>
              <th scope="row">{week.label}</th>
              <td>{week.range}</td>
              <td>{formatCedis(week.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

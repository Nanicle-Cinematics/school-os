import Link from "next/link";
import type { Collections } from "@/lib/dashboard-data";
import { formatCedis } from "@/lib/dashboard-data";
import { Card } from "../ui";

/** The card's own "see more" — every week of the term, not just the last dozen. */
const FullReportLink = () => (
  <Link
    href="/payments/collections"
    className="text-xs font-medium text-slate-500 hover:text-slate-900"
  >
    Full report →
  </Link>
);

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
  const { weeks, total, best, termWeeks, currentWeek } = collections;

  /**
   * The rest of the term, drawn as empty slots rather than left as white space.
   *
   * ⚠️ These are NOT weeks in the data — `getCollections` deliberately returns
   * only the window that has happened, because a tail of zero-height bars reads
   * as collections collapsing rather than as a term still running. But the
   * opposite failure is just as bad: two weeks of a fifteen-week term stretched
   * across a full-width card looked like a broken chart. So the slots are drawn
   * as absence — no bar, a faint baseline, a muted number — and the subtitle
   * says which week of how many, which is the fact that makes an early chart
   * read as early.
   */
  if (weeks.length === 0) {
    return (
      <Card title="Fees collected by week">
        <p className="px-4 py-8 text-center text-sm text-slate-500">
          Nothing collected yet this term. Bars appear as payments are recorded.
        </p>
      </Card>
    );
  }

  /**
   * ⚠️ Under three weeks, this is NOT a bar chart.
   *
   * The runway of empty slots was meant to say "the term is young". With one
   * week of data it said something else entirely: one green bar marooned in
   * eleven grey ghosts reads as a chart that failed to load, which is the worst
   * thing a figure on a dashboard can look like — and a head teacher who
   * believes the dashboard is broken stops believing the rest of it.
   *
   * A chart of one point is not a chart. So until there are three weeks to
   * compare, the card shows the fact plainly: what has come in, against what
   * was billed, and how far into the term that is.
   */
  if (weeks.length < 3) {
    const pct = billed > 0 ? Math.min(100, (total / billed) * 100) : 0;
    return (
      <Card title="Fees collected by week">
        <div className="px-4.5 pb-5 pt-4">
          <p className="font-heading text-[30px] leading-none tabular-nums text-slate-900">
            {formatCedis(total)}
          </p>
          <p className="mt-1.5 text-[13px] text-slate-500">
            collected of {formatCedis(billed)} billed
            {currentWeek > 0 && termWeeks > 0
              ? ` · week ${currentWeek} of ${termWeeks}`
              : ""}
          </p>
          <span className="mt-4 block h-2.5 overflow-hidden rounded-full bg-slate-100">
            <span
              className="block h-full rounded-full bg-brand-600"
              style={{ width: `${pct}%` }}
            />
          </span>
          <p className="mt-2.5 text-xs text-slate-500">
            {weeks.length === 1
              ? "Week by week comparison begins once the term has a few weeks behind it."
              : "One more week and this becomes a week-by-week chart."}
          </p>
        </div>
      </Card>
    );
  }

  /**
   * And once it IS a chart, the runway is no longer than the term behind it.
   * Four weeks of data earn at most four empty slots; fifteen weeks of runway
   * behind three bars is the same marooning by a smaller margin.
   */
  const ahead = Math.max(
    0,
    Math.min(termWeeks - weeks.length, 12 - weeks.length, weeks.length),
  );


  return (
    <Card title="Fees collected by week" action={<FullReportLink />}>
      <div className="px-4 pb-4 pt-3">
        <p className="mb-4 text-xs text-slate-500">
          {currentWeek > 0 && termWeeks > 0 ? (
            <>
              <span className="font-semibold text-slate-600">
                Week {currentWeek} of {termWeeks}
              </span>
              {" · "}
            </>
          ) : null}
          {formatCedis(total)} of {formatCedis(billed)} billed
        </p>

        {/* Bar heights are in PIXELS, not percentages. A percentage height needs a
            parent with a definite height, and inside a flex row with `items-end`
            the columns size to their content — so the first version of this chart
            rendered labels with no bars at all. */}
        {/* overflow-x-auto, because the columns below are deliberately a fixed
            44px and a term is 15 weeks: past about eight of them the row is
            wider than a 390px phone. Scrolling it HERE keeps that decision and
            keeps the page itself from scrolling sideways, which is what it did
            before — the whole dashboard shifted under the thumb, and mobile
            Chrome zoomed the page out to fit. Pair with min-w-0 on the grid
            column in page.tsx; without that the grid item never shrinks and this
            never gets the chance to scroll. */}
        <div className="-mx-4 overflow-x-auto px-4">
          <div className="flex items-end gap-1.5" style={{ height: `${PLOT + 16}px` }}>
          {weeks.map((week) => {
            const label = week.isCurrent || (week.amount === best && best > 0);
            const height = week.amount > 0 ? Math.max(4, Math.round(week.share * PLOT)) : 2;
            return (
              // Fixed-width columns, not `flex-1`. Stretching two weeks across a
              // full-width card left a bar stranded in 500px of nothing; a week
              // is a fixed thing, so it gets a fixed slot and the row fills as
              // the term goes on.
              <div key={week.index} className="flex w-11 shrink-0 flex-col items-center">
                {/* A column is 44px and "GH₵26,542" is not — printed inside the
                    column it truncated to "GH₵26…", which is worse than no label
                    at all. It is centred over the column and allowed to overhang
                    the gaps beside it; at most two are ever shown. */}
                <span className="relative mb-1 block h-[14px] w-full">
                  {label && week.amount > 0 ? (
                    <span
                      className={`absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-extrabold ${
                        week.isCurrent ? "text-accent-600" : "text-slate-400"
                      }`}
                    >
                      {formatCedis(week.amount)}
                    </span>
                  ) : null}
                </span>
                <div
                  title={`${week.label} · ${week.range} · ${formatCedis(week.amount)}`}
                  style={{ height: `${height}px` }}
                  className={`w-full rounded-t-[4px] ${
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

          {Array.from({ length: ahead }, (_, i) => (
            <div
              key={`ahead-${i}`}
              className="flex w-11 shrink-0 flex-col items-center"
              aria-hidden="true"
            >
              <span className="mb-1 h-[14px]" />
              <div className="h-[2px] w-full rounded-full bg-slate-100" />
            </div>
          ))}
          </div>
        </div>

        <div className="mt-2 flex gap-1.5">
          {weeks.map((week) => (
            <span
              key={week.index}
              className={`w-11 shrink-0 truncate text-center text-[10.5px] ${
                week.isCurrent ? "font-extrabold text-slate-700" : "text-slate-400"
              }`}
            >
              {week.label}
            </span>
          ))}
          {Array.from({ length: ahead }, (_, i) => (
            <span
              key={`ahead-label-${i}`}
              className="w-11 shrink-0 truncate text-center text-[10.5px] text-slate-300"
              aria-hidden="true"
            >
              {`Wk ${weeks.length + i + 1}`}
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

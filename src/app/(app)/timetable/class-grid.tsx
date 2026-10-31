"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { WEEKDAYS, nextLessonPeriod, type PeriodRow } from "@/lib/timetable-rules";
import { Alert, filterClass } from "../ui";

export type GridCell = {
  weekday: number;
  periodId: string;
  subjectId: string;
  subjectName: string;
  teachers: string[];
  clash: string | null;
};

type Subject = { id: string; name: string };
type Post = { ok?: string; error?: string; unstaffed?: boolean };

/**
 * One class's week. A head places a lesson by choosing a subject in a cell; the
 * choice is sent at once and either kept or put back with the reason.
 *
 * The cells are not a form on purpose. A form action resets its fields when it
 * returns, so the first refused lesson ("that teacher is already in Basic 6")
 * would wipe the other thirty-odd choices. Here each cell answers for itself:
 * the select is only changed on screen once the server has said yes.
 */
export function ClassGrid({
  classGroupId,
  periods,
  subjects,
  cells,
  editable,
}: {
  classGroupId: string;
  periods: PeriodRow[];
  subjects: Subject[];
  cells: GridCell[];
  editable: boolean;
}) {
  const router = useRouter();
  const byCell = new Map(cells.map((cell) => [`${cell.weekday}|${cell.periodId}`, cell]));
  const [double, setDouble] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "success" | "warning"; text: string } | null>(null);
  // What the select shows for a cell the server has agreed to, ahead of the refresh that re-reads it.
  // The page keys this component on the lessons it holds, so a refresh that brings different ones starts clean.
  const [chosen, setChosen] = useState<Record<string, string>>({});

  async function choose(weekday: number, periodId: string, subjectId: string) {
    const cell = `${weekday}|${periodId}`;
    setBusy(cell);
    setMessage(null);
    try {
      const response = await fetch("/api/timetable/slot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ classGroupId, weekday, periodId, subjectId, double: double && subjectId !== "" }),
        credentials: "same-origin",
        redirect: "manual",
      });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        setMessage({ tone: "error", text: "You have been signed out. Sign in again and try that lesson again." });
        return;
      }
      const body = (await response.json().catch(() => ({}))) as Post & { cells?: { weekday: number; periodId: string }[] };
      if (!response.ok) {
        setMessage({ tone: "error", text: body.error ?? "That lesson could not be saved." });
        return;
      }
      setChosen((prev) => ({
        ...prev,
        ...Object.fromEntries((body.cells ?? [{ weekday, periodId }]).map((c) => [`${c.weekday}|${c.periodId}`, subjectId])),
      }));
      setMessage({
        tone: body.unstaffed ? "warning" : "success",
        text: body.unstaffed
          ? `${body.ok} Nobody is assigned to teach this subject to this class yet, so no teacher is shown.`
          : (body.ok ?? "Saved."),
      });
      router.refresh();
    } catch {
      setMessage({ tone: "error", text: "Could not reach the server. Nothing was changed; try again." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {editable ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-4 py-3 print:hidden">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={double}
              onChange={(event) => setDouble(event.target.checked)}
              className="h-4 w-4 rounded border-hairline"
            />
            Fill two periods at once (a double lesson)
          </label>
          <span className="text-xs text-slate-500">
            Choose a subject in a cell and it also fills the lesson straight after it. Not across a break.
          </span>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] border-collapse text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-caption font-semibold text-slate-500">
              <th scope="col" className="w-32 px-3 py-2">
                Period
              </th>
              {WEEKDAYS.map((day) => (
                <th key={day.n} scope="col" className="px-3 py-2">
                  <span className="sm:hidden">{day.short}</span>
                  <span className="hidden sm:inline">{day.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {periods.map((period) =>
              period.isBreak ? (
                <tr key={period.id} className="bg-slate-50/60">
                  <th scope="row" className="px-3 py-1.5 text-left text-xs font-semibold text-slate-500">
                    {period.label}
                    <span className="block font-normal tabular-nums text-slate-400">
                      {period.startTime}–{period.endTime}
                    </span>
                  </th>
                  <td colSpan={5} className="px-3 py-1.5 text-center text-xs text-slate-400">
                    {period.label}
                  </td>
                </tr>
              ) : (
                <tr key={period.id} className="border-t border-slate-100 align-top">
                  <th scope="row" className="px-3 py-2 text-left text-xs font-semibold text-slate-700">
                    {period.label}
                    <span className="block font-normal tabular-nums text-slate-400">
                      {period.startTime}–{period.endTime}
                    </span>
                  </th>
                  {WEEKDAYS.map((day) => {
                    const id = `${day.n}|${period.id}`;
                    const cell = byCell.get(id);
                    const value = chosen[id] ?? cell?.subjectId ?? "";
                    const hasNext = nextLessonPeriod(periods, period.id) !== null;
                    return (
                      <td key={day.n} className={`px-2 py-2 ${cell?.clash ? "bg-warning-tint/50" : ""}`}>
                        {editable ? (
                          <select
                            aria-label={`${day.label}, ${period.label}`}
                            value={value}
                            disabled={busy === id}
                            onChange={(event) => void choose(day.n, period.id, event.target.value)}
                            className={`${filterClass} w-full min-w-[8rem] text-xs`}
                          >
                            <option value="">—</option>
                            {subjects.map((subject) => (
                              <option key={subject.id} value={subject.id} disabled={double && !hasNext}>
                                {subject.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="block font-medium text-slate-900">{cell?.subjectName ?? ""}</span>
                        )}
                        {cell && cell.teachers.length > 0 ? (
                          <span className="mt-1 block text-caption text-slate-500">{cell.teachers.join(", ")}</span>
                        ) : cell ? (
                          <span className="mt-1 block text-caption text-slate-400">no teacher assigned</span>
                        ) : null}
                        {cell?.clash ? (
                          <span className="mt-1 block text-caption font-semibold text-warning-ink">⚠ {cell.clash}</span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-2 px-4 py-3 print:hidden" aria-live="polite">
        {message?.tone === "error" ? <Alert tone="error">{message.text}</Alert> : null}
        {message?.tone === "success" ? <Alert tone="success">{message.text}</Alert> : null}
        {message?.tone === "warning" ? (
          <p role="status" className="rounded-control bg-warning-tint px-3.5 py-2.5 text-sm text-warning-ink">
            {message.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

import { WEEKDAYS, type PeriodRow } from "@/lib/timetable-rules";
import type { TeacherCell } from "@/lib/timetable-data";

/**
 * One teacher's week, read-only. A server component: nothing here changes.
 * A cell holding two lessons is the clash, shown rather than hidden.
 */
export function WeekGrid({ periods, cells }: { periods: PeriodRow[]; cells: TeacherCell[] }) {
  const byCell = new Map(cells.map((cell) => [`${cell.weekday}|${cell.periodId}`, cell]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[48rem] border-collapse text-sm">
        <thead>
          <tr className="bg-slate-50 text-left text-caption font-semibold text-slate-500">
            <th scope="col" className="w-32 px-3 py-2">Period</th>
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
                  <span className="block font-normal tabular-nums text-slate-400">{period.startTime}–{period.endTime}</span>
                </th>
                <td colSpan={5} className="px-3 py-1.5 text-center text-xs text-slate-400">{period.label}</td>
              </tr>
            ) : (
              <tr key={period.id} className="border-t border-slate-100 align-top">
                <th scope="row" className="px-3 py-2 text-left text-xs font-semibold text-slate-700">
                  {period.label}
                  <span className="block font-normal tabular-nums text-slate-400">{period.startTime}–{period.endTime}</span>
                </th>
                {WEEKDAYS.map((day) => {
                  const cell = byCell.get(`${day.n}|${period.id}`);
                  const clash = (cell?.lessons.length ?? 0) > 1;
                  return (
                    <td key={day.n} className={`px-2 py-2 ${clash ? "bg-warning-tint/50" : ""}`}>
                      {cell?.lessons.map((lesson) => (
                        <span key={`${lesson.classLabel}${lesson.subjectName}`} className="mb-1 block">
                          <span className="block font-medium text-slate-900">{lesson.subjectName}</span>
                          <span className="block text-caption text-slate-500">{lesson.classLabel}</span>
                        </span>
                      ))}
                      {clash ? <span className="block text-caption font-semibold text-warning-ink">⚠ In two classes at once</span> : null}
                    </td>
                  );
                })}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

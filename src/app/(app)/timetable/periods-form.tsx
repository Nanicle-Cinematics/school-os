"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClass } from "../button-style";
import { Alert, filterClass } from "../ui";

export type PeriodFormRow = {
  /** Present for a period that already exists, so its lessons stay with it. */
  id?: string;
  label: string;
  startTime: string;
  endTime: string;
  isBreak: boolean;
  /** Lessons on the timetable that sit in this period. */
  lessons: number;
};

type Answer = { ok?: string; error?: string; errors?: string[] };

async function post(body: unknown): Promise<Answer & { signedOut?: boolean }> {
  const response = await fetch("/api/timetable/periods", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    redirect: "manual",
  });
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    return { signedOut: true };
  }
  return (await response.json().catch(() => ({ error: "The server gave an answer that could not be read." }))) as Answer;
}

/** HH:MM plus minutes, for a new row that starts where the last one ended. */
function plus(time: string, minutes: number) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return "";
  const total = Math.min(23 * 60 + 59, Number(match[1]) * 60 + Number(match[2]) + minutes);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The school day, edited as one list and saved in one go.
 *
 * Not a form action: the server may refuse several rows at once (a time out of
 * order, a period that still has lessons), and a form resets its fields when it
 * returns, which would throw away the other rows the head had just retyped.
 * The rows live in state; nothing changes them but the head.
 */
export function PeriodsForm({ initial }: { initial: PeriodFormRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<PeriodFormRow[]>(initial);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);

  const set = (index: number, patch: Partial<PeriodFormRow>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const move = (index: number, by: -1 | 1) =>
    setRows((prev) => {
      const target = index + by;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  async function save() {
    setBusy(true);
    setAnswer(null);
    try {
      const result = await post({
        rows: rows.map(({ id, label, startTime, endTime, isBreak }) => ({ id, label, startTime, endTime, isBreak })),
      });
      if (result.signedOut) {
        setAnswer({ error: "You have been signed out. Sign in again; what you typed is still here." });
        return;
      }
      setAnswer(result);
      if (result.ok) router.refresh();
    } catch {
      setAnswer({ error: "Could not reach the server. Nothing was changed; try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <thead>
            <tr className="bg-slate-50 text-left text-caption font-semibold text-slate-500">
              <th scope="col" className="px-3 py-2">Name</th>
              <th scope="col" className="px-3 py-2">Starts</th>
              <th scope="col" className="px-3 py-2">Ends</th>
              <th scope="col" className="px-3 py-2">A break?</th>
              <th scope="col" className="px-3 py-2"><span className="sr-only">Move or remove</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id ?? `new-${index}`} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <input
                    aria-label={`Name of row ${index + 1}`}
                    value={row.label}
                    maxLength={30}
                    onChange={(event) => set(index, { label: event.target.value })}
                    className={`${filterClass} w-40`}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    aria-label={`${row.label || `Row ${index + 1}`} starts`}
                    value={row.startTime}
                    inputMode="numeric"
                    placeholder="08:00"
                    onChange={(event) => set(index, { startTime: event.target.value })}
                    className={`${filterClass} w-24 tabular-nums`}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    aria-label={`${row.label || `Row ${index + 1}`} ends`}
                    value={row.endTime}
                    inputMode="numeric"
                    placeholder="08:40"
                    onChange={(event) => set(index, { endTime: event.target.value })}
                    className={`${filterClass} w-24 tabular-nums`}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`${row.label || `Row ${index + 1}`} is a break`}
                    checked={row.isBreak}
                    onChange={(event) => set(index, { isBreak: event.target.checked })}
                    className="h-4 w-4 rounded border-hairline"
                  />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${row.label || "row"} up`} className="px-2 text-slate-500 disabled:opacity-30">↑</button>
                  <button type="button" onClick={() => move(index, 1)} disabled={index === rows.length - 1} aria-label={`Move ${row.label || "row"} down`} className="px-2 text-slate-500 disabled:opacity-30">↓</button>
                  <button
                    type="button"
                    onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                    disabled={row.lessons > 0}
                    title={row.lessons > 0 ? `${row.lessons} lesson${row.lessons === 1 ? "" : "s"} on the timetable use this period` : "Remove"}
                    className="px-2 text-sm font-semibold text-danger-ink disabled:text-slate-300"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 border-t border-hairline p-4">
        {answer?.error ? <Alert tone="error">{answer.error}</Alert> : null}
        {answer?.errors?.length ? (
          <Alert tone="error">
            <ul className="list-disc space-y-0.5 pl-4">
              {answer.errors.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {answer?.ok ? <Alert tone="success">{answer.ok}</Alert> : null}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              const last = rows[rows.length - 1];
              setRows((prev) => [
                ...prev,
                {
                  label: `Period ${prev.filter((r) => !r.isBreak).length + 1}`,
                  startTime: last?.endTime ?? "08:00",
                  endTime: plus(last?.endTime ?? "08:00", 40),
                  isBreak: false,
                  lessons: 0,
                },
              ]);
            }}
            className={buttonClass("secondary")}
          >
            Add a period
          </button>
          <button type="button" onClick={save} disabled={busy} className={buttonClass("primary")}>
            {busy ? "Saving…" : "Save the school day"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** For a school with no day yet: give it the standard one to edit. */
export function StandardDayButton({ variant = "primary" }: { variant?: "primary" | "secondary" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const result = await post({ standard: true });
            if (result.ok) router.refresh();
            else setError(result.signedOut ? "You have been signed out. Sign in again." : (result.error ?? "Could not add the school day."));
          } catch {
            setError("Could not reach the server. Try again.");
          } finally {
            setBusy(false);
          }
        }}
        className={buttonClass(variant)}
      >
        {busy ? "Adding…" : "Use the standard school day"}
      </button>
      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}

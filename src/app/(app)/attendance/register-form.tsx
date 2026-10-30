"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import type { AttendanceMark } from "@prisma/client";
import { saveRegister, type RegisterState } from "@/lib/attendance-actions";
import {
  describe,
  registerKey,
  type OfflineEntry,
  type OfflineRoll,
} from "@/lib/offline-register";
import {
  adoptOwner,
  deleteEntry,
  getEntry,
  offlineAvailable,
  pruneStale,
  putEntry,
  saveRoll,
} from "@/lib/offline-store";
import { primeOfflinePage } from "@/lib/offline-prime";
import { flushQueue } from "@/lib/offline-sync";
import { notifyOfflineChanged } from "@/app/offline-sync";
import { SubmitButton } from "../submit-button";
import { Alert } from "../ui";

export type RegisterRowView = {
  studentId: string;
  admissionNo: string;
  name: string;
  mark: AttendanceMark | null;
  note: string | null;
};

/**
 * Four marks, in the order a teacher reaches for them.
 *
 * Present first because it is the overwhelming majority of every register, and
 * Absent last because reaching past Late and Excused to get to it is a small
 * pause in exactly the place a pause is worth having.
 */
const MARKS: { value: AttendanceMark; short: string; label: string; tone: string }[] = [
  { value: "PRESENT", short: "P", label: "Present", tone: "bg-success-tint text-success-ink" },
  { value: "LATE", short: "L", label: "Late", tone: "bg-warning-tint text-warning-ink" },
  { value: "EXCUSED", short: "E", label: "Excused", tone: "bg-slate-200 text-slate-700" },
  { value: "ABSENT", short: "A", label: "Absent", tone: "bg-danger-tint text-danger-ink" },
];

/** How long the server gets before the register is kept on the phone instead. */
const SERVER_PATIENCE_MS = 20_000;

type Result = RegisterState & { kept?: boolean };

/**
 * One class's register for one day.
 *
 * Online it posts to the `saveRegister` action, exactly as it always did. Two
 * additions make it survive a bad connection:
 *
 *  - What is typed is kept on the phone as it is typed, so a closed app or a
 *    dropped signal loses nothing.
 *  - If the save cannot reach the server (no signal, a request that never
 *    answers, a fault), the register is kept on the phone as QUEUED and sent
 *    by `OfflineSync` when the phone is online again. The teacher is told it is
 *    not on the server yet; "saved" is never claimed for what is only here.
 *
 * `offlineOnly` is the same form rendered by the offline page, which has no
 * server to ask and only ever keeps the register.
 *
 * ⚠️ The submit handler calls the action itself instead of handing it to
 * `useActionState`, because a failed request inside a form action surfaces as
 * a render error and not as something this component can catch. The form still
 * carries `action={formAction}` so that its server-rendered fallback (hidden
 * action fields, which the HTTP guards post to) is exactly what it was.
 */
export function RegisterForm({
  classGroupId,
  classLabel,
  date,
  boys,
  girls,
  taken,
  who,
  offlineOnly = false,
}: {
  classGroupId: string;
  /** "Basic 4 A": what the offline page calls this class. */
  classLabel: string;
  date: string;
  boys: RegisterRowView[];
  girls: RegisterRowView[];
  taken: boolean;
  /** Whose phone this is, for the online page. The offline page reads it from the store. */
  who?: { userId: string; schoolId: string };
  offlineOnly?: boolean;
}) {
  const [, formAction] = useActionState<RegisterState, FormData>(saveRegister, {});
  const rows = useMemo(() => [...boys, ...girls], [boys, girls]);
  const key = registerKey(classGroupId, date);

  const [marks, setMarks] = useState<Record<string, AttendanceMark | "">>(() =>
    Object.fromEntries(rows.map((row) => [row.studentId, row.mark ?? ""])),
  );
  const [notes, setNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((row) => [row.studentId, row.note ?? ""])),
  );
  const [result, setResult] = useState<Result>({});
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState<OfflineEntry["status"] | null>(null);

  // Has the person changed anything since the page opened? Only then is there
  // anything to keep, and it stops the restore below writing an echo of itself.
  const touched = useRef(false);
  const status = useRef<OfflineEntry["status"]>("draft");

  const edit = (apply: () => void) => {
    touched.current = true;
    apply();
  };

  // On the online page: claim the phone for this person, refresh the class list
  // kept for offline use, and warm the offline page so it opens with no signal.
  useEffect(() => {
    if (offlineOnly || !who || !offlineAvailable()) return;
    let cancelled = false;
    (async () => {
      await adoptOwner(who);
      await pruneStale(new Date());
      if (cancelled) return;
      const roll: OfflineRoll = {
        classGroupId,
        className: classLabel,
        userId: who.userId,
        schoolId: who.schoolId,
        rows: [
          ...boys.map((row) => ({ ...pick(row), gender: "MALE" as const })),
          ...girls.map((row) => ({ ...pick(row), gender: "FEMALE" as const })),
        ],
        savedAt: new Date().toISOString(),
      };
      await saveRoll(roll);
    })();
    // Cache the offline page and its scripts so it opens with no signal.
    void primeOfflinePage();
    return () => {
      cancelled = true;
    };
    // The roll is refreshed when the class or the day changes, not on each tap.
  }, [classGroupId, classLabel, who, boys, girls, offlineOnly]);

  // Bring back what the phone is holding for this class and day.
  useEffect(() => {
    if (!offlineAvailable()) return;
    let cancelled = false;
    getEntry(key).then((entry) => {
      if (cancelled || !entry || touched.current) return;
      status.current = entry.status;
      setMarks((prev) => ({ ...prev, ...pickKnown(entry.marks, rows) }));
      setNotes((prev) => ({ ...prev, ...entry.notes }));
      setRestored(entry.status);
      if (entry.status === "failed" && entry.error) {
        setResult({ error: entry.error });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, rows]);

  // Keep what is typed. A register already waiting to be sent stays waiting
  // (the teacher pressed Save; later taps are corrections to it), anything
  // else goes back to being a draft that is NOT sent until Save is pressed.
  useEffect(() => {
    if (!touched.current || !offlineAvailable()) return;
    const timer = setTimeout(() => {
      // A save may have finished since this was scheduled; writing now would
      // bring back a draft of what was just saved.
      if (!touched.current) return;
      const keep: OfflineEntry["status"] = status.current === "queued" ? "queued" : "draft";
      status.current = keep;
      putEntry({
        key,
        classGroupId,
        date,
        status: keep,
        marks,
        notes,
        updatedAt: new Date().toISOString(),
        error: null,
      }).then(notifyOfflineChanged);
    }, 400);
    return () => clearTimeout(timer);
  }, [marks, notes, key, classGroupId, date]);

  const counts = rows.reduce(
    (acc, row) => {
      const mark = marks[row.studentId];
      if (mark === "PRESENT" || mark === "LATE") acc.inSchool += 1;
      else if (mark === "EXCUSED" || mark === "ABSENT") acc.away += 1;
      else acc.unmarked += 1;
      return acc;
    },
    { inSchool: 0, away: 0, unmarked: 0 },
  );

  /** Keep the register on the phone, to be sent when there is a signal. */
  async function keepOnPhone(why: string) {
    const entry: OfflineEntry = {
      key,
      classGroupId,
      date,
      status: "queued",
      marks,
      notes,
      updatedAt: new Date().toISOString(),
      error: null,
    };
    await putEntry(entry);
    status.current = "queued";
    notifyOfflineChanged();
    const c = describe(entry);
    setResult({
      kept: true,
      ok: `${why} Kept on this phone (${c.inSchool} in school, ${c.away} away) and sent when you are back online.`,
    });
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setResult({});
    try {
      if (offlineOnly || navigator.onLine === false) {
        await keepOnPhone(offlineOnly ? "" : "No signal.");
        return;
      }
      const TIMED_OUT = Symbol("timed out");
      const outcome = await Promise.race([
        saveRegister({}, data),
        new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), SERVER_PATIENCE_MS)),
      ]);
      if (outcome === TIMED_OUT) {
        // The request may still land; sending it again later is harmless
        // because a register is the same whichever copy arrives.
        await keepOnPhone("The school's server is not answering.");
        return;
      }
      setResult(outcome);
      if (outcome.ok) {
        status.current = "draft";
        touched.current = false;
        setRestored(null);
        await deleteEntry(key);
        notifyOfflineChanged();
        // Anything else waiting on the phone can go now that we are connected.
        void flushQueue().then(notifyOfflineChanged);
      }
    } catch {
      await keepOnPhone("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * The one button that makes a daily register survivable.
   *
   * A class of forty is thirty-eight taps of "Present" and two of something
   * else. Starting from all-present and correcting the exceptions is how the
   * paper register is actually kept, and it turns the job into the two marks
   * that carry information.
   */
  const markAllPresent = () =>
    edit(() => setMarks(Object.fromEntries(rows.map((row) => [row.studentId, "PRESENT" as AttendanceMark]))));

  const clearAll = () => edit(() => setMarks(Object.fromEntries(rows.map((row) => [row.studentId, ""]))));

  return (
    <form action={formAction} onSubmit={onSubmit}>
      <input type="hidden" name="classGroupId" value={classGroupId} />
      <input type="hidden" name="date" value={date} />

      {restored === "queued" ? (
        <p className="border-b border-hairline bg-warning-tint px-4 py-2 text-sm text-warning-ink">
          This register is saved on this phone and is waiting to be sent. Nothing is lost if you close the app.
        </p>
      ) : restored === "draft" ? (
        <p className="border-b border-hairline bg-info-tint px-4 py-2 text-sm text-info-ink">
          Marks you had typed here are back. Press Save when you are done.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-b border-hairline p-4">
        <button
          type="button"
          onClick={markAllPresent}
          className="rounded-full bg-success-tint px-3 py-1.5 text-sm font-semibold text-success-ink transition hover:brightness-95"
        >
          Everyone present
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="rounded-full border border-hairline px-3 py-1.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
        >
          Clear
        </button>
        <p className="ml-auto text-xs text-slate-500">
          {counts.inSchool} in school · {counts.away} away
          {counts.unmarked > 0 ? ` · ${counts.unmarked} not marked` : ""}
        </p>
      </div>

      <div className="divide-y divide-slate-100">
        {[
          { label: "Boys", rows: boys },
          { label: "Girls", rows: girls },
        ].map((section) =>
          section.rows.length === 0 ? null : (
            <div key={section.label}>
              <p className="bg-slate-50 px-4 py-1.5 text-caption font-semibold text-slate-500">
                {section.label} ({section.rows.length})
              </p>
              {section.rows.map((row, index) => {
                const mark = marks[row.studentId];
                return (
                  <div
                    key={row.studentId}
                    className="flex flex-wrap items-center gap-3 border-t border-slate-100 px-4 py-2"
                  >
                    <span className="w-6 shrink-0 text-right text-xs tabular-nums text-slate-400">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-900">{row.name}</span>
                      <span className="font-mono text-xs text-slate-400">{row.admissionNo}</span>
                    </span>

                    <input type="hidden" name={`mark:${row.studentId}`} value={mark} />

                    <span className="flex shrink-0 gap-1">
                      {MARKS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={mark === option.value}
                          aria-label={`${row.name}: ${option.label}`}
                          title={option.label}
                          onClick={() =>
                            edit(() =>
                              setMarks((prev) => ({
                                ...prev,
                                // Pressing the mark a child already has takes it
                                // off, so a mis-tap has an undo that is not
                                // "guess what it was before".
                                [row.studentId]: prev[row.studentId] === option.value ? "" : option.value,
                              })),
                            )
                          }
                          className={`h-9 w-9 rounded-full text-sm font-extrabold transition ${
                            mark === option.value
                              ? option.tone
                              : "border border-hairline bg-surface text-slate-400 hover:bg-slate-50"
                          }`}
                        >
                          {option.short}
                        </button>
                      ))}
                    </span>

                    {mark === "EXCUSED" ? (
                      <input
                        type="text"
                        name={`note:${row.studentId}`}
                        value={notes[row.studentId] ?? ""}
                        onChange={(event) =>
                          edit(() => setNotes((prev) => ({ ...prev, [row.studentId]: event.target.value })))
                        }
                        placeholder="Reason (sick, funeral…)"
                        maxLength={200}
                        className="w-full rounded-lg border border-hairline bg-surface px-3 py-1.5 text-sm sm:w-56"
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ),
        )}
      </div>

      <div className="space-y-3 border-t border-hairline p-4">
        {result.error ? <Alert tone="error">{result.error}</Alert> : null}
        {result.ok && result.kept ? (
          <p role="status" className="rounded-control bg-warning-tint px-3.5 py-2.5 text-sm text-warning-ink">
            {result.ok}
          </p>
        ) : result.ok ? (
          <Alert tone="success">{result.ok}</Alert>
        ) : null}

        <SubmitButton disabled={busy}>
          {busy ? "Saving…" : offlineOnly ? "Save on this phone" : taken ? "Update the register" : "Save the register"}
        </SubmitButton>
      </div>
    </form>
  );
}

function pick(row: RegisterRowView) {
  return { studentId: row.studentId, admissionNo: row.admissionNo, name: row.name };
}

/** Only the children on screen; a child who has left the roll since is dropped. */
function pickKnown(saved: OfflineEntry["marks"], rows: RegisterRowView[]) {
  const known = new Set(rows.map((row) => row.studentId));
  return Object.fromEntries(Object.entries(saved).filter(([id]) => known.has(id))) as Record<
    string,
    AttendanceMark | ""
  >;
}

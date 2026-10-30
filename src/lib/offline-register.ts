/**
 * The rules for taking a register without a signal. Pure: no React, no
 * IndexedDB, no database, so the browser, the sync route and `verify:offline-register`
 * all run the SAME functions.
 *
 * The shape of the feature, because the rules below only make sense inside it:
 *
 *  - A form teacher opens /attendance while online. The page keeps the class's
 *    roll on the phone (`OfflineRoll`) and the marks being typed (`OfflineEntry`).
 *  - With no signal, Save keeps the register on the phone as "queued". When the
 *    phone is online again it is posted to /api/attendance/sync, which runs the
 *    same rules as the online form.
 *  - The phone keeps one class's names and admission numbers. That is personal
 *    data on a device, so it is bounded: this teacher's own class, seven days,
 *    and gone at sign-out or when a different person signs in.
 */

export const MARK_VALUES = ["PRESENT", "LATE", "EXCUSED", "ABSENT"] as const;
export type MarkValue = (typeof MARK_VALUES)[number];

/** How long a downloaded roll is trusted, and then deleted unused. */
export const ROLL_MAX_AGE_DAYS = 7;
/** The most registers one post carries: a fortnight for a form teacher, with room. */
export const SYNC_MAX_ITEMS = 20;
/** The largest class this accepts. A real class is 20 to 60. */
export const SYNC_MAX_CHILDREN = 200;
const NOTE_MAX = 200;
const ID_MAX = 64;

export type OfflineRow = {
  studentId: string;
  admissionNo: string;
  name: string;
  gender: "MALE" | "FEMALE";
};

/** A class's roll, as downloaded. Belongs to whoever downloaded it. */
export type OfflineRoll = {
  classGroupId: string;
  className: string;
  userId: string;
  schoolId: string;
  rows: OfflineRow[];
  /** ISO time it was downloaded. */
  savedAt: string;
};

/**
 * One class on one day, as it exists on the phone.
 *
 * - `draft`: being typed. Kept so closing the app loses nothing; never sent.
 * - `queued`: Save was pressed with no signal. Sent when the phone is online.
 * - `failed`: the server refused it. Kept, with the reason, for the teacher to fix.
 */
export type OfflineEntry = {
  key: string;
  classGroupId: string;
  date: string;
  status: "draft" | "queued" | "failed";
  marks: Record<string, MarkValue | "">;
  notes: Record<string, string>;
  /** ISO time the teacher last changed it (sent as `markedAt`). */
  updatedAt: string;
  error: string | null;
};

export type SyncItem = {
  key: string;
  classGroupId: string;
  date: string;
  marks: Record<string, MarkValue | "">;
  notes: Record<string, string>;
  markedAt: string;
};

/**
 * `retry`: the server could not try (a database blip), as opposed to refusing
 * the register. A refusal needs a person; a blip only needs another go.
 */
export type SyncResult =
  | { key: string; ok: true; message: string }
  | { key: string; ok: false; error: string; retry?: boolean };

export function registerKey(classGroupId: string, date: string) {
  return `${classGroupId}|${date}`;
}

export function isMark(value: unknown): value is MarkValue {
  return typeof value === "string" && (MARK_VALUES as readonly string[]).includes(value);
}

/** yyyy-mm-dd and a real calendar day (not 2026-02-31). */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function rollIsFresh(roll: Pick<OfflineRoll, "savedAt">, now: Date) {
  const saved = new Date(roll.savedAt).getTime();
  if (Number.isNaN(saved)) return false;
  return now.getTime() - saved <= ROLL_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/** Whether what is on the phone belongs to the person using it. */
export function belongsTo(roll: Pick<OfflineRoll, "userId" | "schoolId">, who: { userId: string; schoolId: string }) {
  return roll.userId === who.userId && roll.schoolId === who.schoolId;
}

/** Only `queued` registers are sent; a draft is not finished and a failed one needs a person. */
export function toSyncItems(entries: OfflineEntry[]): SyncItem[] {
  return entries
    .filter((entry) => entry.status === "queued")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(0, SYNC_MAX_ITEMS)
    .map((entry) => ({
      key: entry.key,
      classGroupId: entry.classGroupId,
      date: entry.date,
      marks: entry.marks,
      notes: entry.notes,
      markedAt: entry.updatedAt,
    }));
}

/**
 * What to keep after the server has answered.
 *
 * A saved register is dropped; a refused one stays, marked failed, with the
 * server's words. An entry the teacher edited WHILE the post was in flight has
 * a newer `updatedAt` than the one that was sent and is left alone: dropping it
 * would throw away marks the server never saw.
 */
export function applyResults(entries: OfflineEntry[], sent: SyncItem[], results: SyncResult[]): OfflineEntry[] {
  const sentAt = new Map(sent.map((item) => [item.key, item.markedAt]));
  const byKey = new Map(results.map((result) => [result.key, result]));
  const kept: OfflineEntry[] = [];
  for (const entry of entries) {
    const result = byKey.get(entry.key);
    const wasSent = sentAt.has(entry.key);
    if (!result || !wasSent || entry.updatedAt !== sentAt.get(entry.key)) {
      kept.push(entry);
    } else if (!result.ok) {
      kept.push(result.retry ? entry : { ...entry, status: "failed", error: result.error });
    }
    // else: saved, drop it.
  }
  return kept;
}

export type ParsedSync = { ok: true; items: SyncItem[] } | { ok: false; error: string };

/**
 * Read the body of a sync post. Everything is untrusted: the queue lives on a
 * phone for as long as the signal is out, and this route is a write.
 */
export function parseSyncBody(body: unknown): ParsedSync {
  if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) {
    return { ok: false, error: "Expected { items: [...] }." };
  }
  const raw = (body as { items: unknown[] }).items;
  if (raw.length === 0) return { ok: false, error: "Nothing to save." };
  if (raw.length > SYNC_MAX_ITEMS) return { ok: false, error: `At most ${SYNC_MAX_ITEMS} registers at a time.` };

  const items: SyncItem[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") return { ok: false, error: "A register was malformed." };
    const item = candidate as Record<string, unknown>;
    const { classGroupId, date, marks, notes, markedAt } = item;

    if (typeof classGroupId !== "string" || classGroupId.length === 0 || classGroupId.length > ID_MAX) {
      return { ok: false, error: "A register had no class." };
    }
    if (!isDay(date)) return { ok: false, error: "A register had a bad date." };
    if (typeof markedAt !== "string" || Number.isNaN(new Date(markedAt).getTime())) {
      return { ok: false, error: "A register had no time." };
    }
    if (!marks || typeof marks !== "object" || Array.isArray(marks)) {
      return { ok: false, error: "A register had no marks." };
    }

    const key = registerKey(classGroupId, date);
    if (seen.has(key)) return { ok: false, error: "The same register was sent twice." };
    seen.add(key);

    const markEntries = Object.entries(marks as Record<string, unknown>);
    if (markEntries.length === 0 || markEntries.length > SYNC_MAX_CHILDREN) {
      return { ok: false, error: "A register had an impossible number of children." };
    }
    const cleanMarks: Record<string, MarkValue | ""> = {};
    for (const [studentId, mark] of markEntries) {
      if (studentId.length === 0 || studentId.length > ID_MAX) return { ok: false, error: "A child id was malformed." };
      if (mark !== "" && !isMark(mark)) return { ok: false, error: "A mark was not one of the four." };
      cleanMarks[studentId] = mark as MarkValue | "";
    }

    const cleanNotes: Record<string, string> = {};
    if (notes !== undefined) {
      if (!notes || typeof notes !== "object" || Array.isArray(notes)) {
        return { ok: false, error: "Notes were malformed." };
      }
      for (const [studentId, note] of Object.entries(notes as Record<string, unknown>)) {
        if (typeof note !== "string") return { ok: false, error: "A note was not text." };
        if (studentId in cleanMarks && note.trim()) cleanNotes[studentId] = note.slice(0, NOTE_MAX);
      }
    }

    items.push({ key, classGroupId, date, marks: cleanMarks, notes: cleanNotes, markedAt });
  }
  return { ok: true, items };
}

/** "12 in school, 3 away, 1 not marked" for the banner that says what is waiting. */
export function describe(entry: Pick<OfflineEntry, "marks">) {
  let inSchool = 0;
  let away = 0;
  let unmarked = 0;
  for (const mark of Object.values(entry.marks)) {
    if (mark === "PRESENT" || mark === "LATE") inSchool += 1;
    else if (mark === "EXCUSED" || mark === "ABSENT") away += 1;
    else unmarked += 1;
  }
  return { inSchool, away, unmarked };
}

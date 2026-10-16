/**
 * Which pupils look like the same child entered twice.
 *
 * Pure: it takes plain rows and returns pairs, so the Duplicates screen and `verify:duplicates` read one rule.
 * A pair is a SUGGESTION for a person to confirm, never a verdict: twins and cousins share surnames and, in a
 * small school, sometimes a parent's phone. So each pair says WHY it was suggested and how sure that is, and
 * nothing is merged without somebody choosing which record to keep.
 *
 * Rules, strongest first (a pair gets the strongest that fits):
 *   - same first and last name and the same date of birth ........ "high"
 *   - first and last name swapped, same date of birth ............ "high"
 *   - a typing slip in one part of the name, same date of birth ... "medium"
 *   - same first and last name and a parent's phone in common .... "medium"
 * A missing date of birth never matches another missing one (that would pair every undated child in the school).
 */
export type DuplicateRow = {
  id: string;
  firstName: string;
  lastName: string;
  /** Any form of one calendar day: only the date part is compared. */
  dateOfBirth: Date | null;
  /** Phones of every guardian linked to the pupil, in any format. */
  guardianPhones: string[];
};

export type DuplicateReason = "same-name-and-birthday" | "swapped-names-same-birthday" | "similar-name-same-birthday" | "same-name-shared-parent-phone";

export type DuplicatePair = { a: string; b: string; reason: DuplicateReason; confidence: "high" | "medium" };

export const REASON_TEXT: Record<DuplicateReason, string> = {
  "same-name-and-birthday": "Same name and date of birth",
  "swapped-names-same-birthday": "First and last name swapped, same date of birth",
  "similar-name-same-birthday": "Almost the same name, same date of birth",
  "same-name-shared-parent-phone": "Same name and a parent's phone number in common",
};

const RANK: Record<DuplicateReason, number> = {
  "same-name-and-birthday": 0,
  "swapped-names-same-birthday": 1,
  "similar-name-same-birthday": 2,
  "same-name-shared-parent-phone": 3,
};

/** Lower-case, accents folded, punctuation and runs of space removed: "Ama  Owusu-Ansah" == "ama owusuansah". */
export function normaliseName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 0244123456, +233 24 412 3456 and 233244123456 are one number: compared on the last nine digits. */
export function phoneKey(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
}

const dayKey = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Levenshtein distance, stopping early once it must exceed `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

export function findDuplicatePairs(rows: DuplicateRow[]): DuplicatePair[] {
  const best = new Map<string, DuplicatePair>();
  const offer = (x: DuplicateRow, y: DuplicateRow, reason: DuplicateReason) => {
    const [a, b] = x.id < y.id ? [x.id, y.id] : [y.id, x.id];
    const key = `${a}|${b}`;
    const have = best.get(key);
    if (!have || RANK[reason] < RANK[have.reason]) {
      best.set(key, { a, b, reason, confidence: RANK[reason] <= 1 ? "high" : "medium" });
    }
  };

  const prepared = rows.map((r) => ({
    row: r,
    first: normaliseName(r.firstName),
    last: normaliseName(r.lastName),
    day: dayKey(r.dateOfBirth),
    phones: new Set(r.guardianPhones.map(phoneKey).filter((p): p is string => p !== null)),
  }));

  // Same birthday: compare within each day's group, which keeps this linear for a school.
  const byDay = new Map<string, typeof prepared>();
  for (const p of prepared) {
    if (p.day) byDay.set(p.day, [...(byDay.get(p.day) ?? []), p]);
  }
  for (const group of byDay.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const x = group[i];
        const y = group[j];
        if (x.first === y.first && x.last === y.last) {
          offer(x.row, y.row, "same-name-and-birthday");
        } else if (x.first === y.last && x.last === y.first) {
          offer(x.row, y.row, "swapped-names-same-birthday");
        } else {
          // A slip in ONE part of the name only. Twins share a surname and a birthday and have first names a
          // letter or two apart (Kofi / Kojo), so a loose match on the whole name suggests every pair of twins:
          // a typo is allowed in the surname when the first name is identical, and a single letter in the first
          // name when the surname is identical. Short names are never matched this way (Ama / Ada).
          const longEnough = (a: string, b: string) => a.length >= 5 && b.length >= 5;
          const surnameSlip = x.first === y.first && longEnough(x.last, y.last) && editDistance(x.last, y.last, 2) <= 2;
          const firstNameSlip = x.last === y.last && longEnough(x.first, y.first) && editDistance(x.first, y.first, 1) <= 1;
          if (surnameSlip || firstNameSlip) {
            offer(x.row, y.row, "similar-name-same-birthday");
          }
        }
      }
    }
  }

  // Same name, a parent's phone in common (a different or missing birthday).
  const byName = new Map<string, typeof prepared>();
  for (const p of prepared) {
    if (p.first && p.last) byName.set(`${p.first}|${p.last}`, [...(byName.get(`${p.first}|${p.last}`) ?? []), p]);
  }
  for (const group of byName.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const x = group[i];
        const y = group[j];
        if ([...x.phones].some((p) => y.phones.has(p))) {
          offer(x.row, y.row, "same-name-shared-parent-phone");
        }
      }
    }
  }

  return [...best.values()].sort((p, q) => RANK[p.reason] - RANK[q.reason] || p.a.localeCompare(q.a));
}

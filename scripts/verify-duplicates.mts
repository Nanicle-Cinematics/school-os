/**
 * Possible duplicate pupils: what is suggested, and what a merge moves, refuses and leaves.
 *
 * Part 1 is the pure detector (`findDuplicatePairs`): every rule, and the near-misses that must NOT match
 * (twins, a missing birthday, short names two letters apart).
 * Part 2 runs the real `mergeStudents` against the demo school INSIDE transactions that are rolled back, so
 * nothing it does is kept: the pupil holding the most history is merged into a new record, then conflicts and
 * the safe overlaps are exercised. Development databases only.
 *
 * Run: npm run verify:duplicates
 */
import { readFileSync } from "node:fs";
import { findDuplicatePairs, editDistance, phoneKey, normaliseName, type DuplicateRow } from "@/lib/duplicate-detect";
import { mergeStudents, type MergeResult } from "@/lib/student-merge";
import { tenantTransaction, type TenantTx } from "@/lib/prisma";
import { getDuplicateCards } from "@/lib/duplicate-data";
import { setTenantContext } from "@/lib/tenant-context";
import { demoSchool, withOwner } from "./fixture.mjs";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const code = (path: string) =>
  readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const row = (id: string, firstName: string, lastName: string, dob: string | null, phones: string[] = []): DuplicateRow => ({ id, firstName, lastName, dateOfBirth: dob ? day(dob) : null, guardianPhones: phones });
const pairOf = (rows: DuplicateRow[]) => findDuplicatePairs(rows).map((p) => `${p.a}-${p.b}:${p.reason}`);

console.log("The detector");
check("same name and birthday is high", findDuplicatePairs([row("a", "Ama", "Owusu", "2015-03-02"), row("b", "Ama", "Owusu", "2015-03-02")])[0]?.confidence === "high");
check("case, spaces, accents and punctuation do not hide a match", pairOf([row("a", "AMA ", "Owusu-Ansah", "2015-03-02"), row("b", "ama", "owusu  ansah", "2015-03-02")]).length === 1);
check("first and last name swapped is found", pairOf([row("a", "Kofi", "Mensah", "2014-01-09"), row("b", "Mensah", "Kofi", "2014-01-09")])[0]?.endsWith("swapped-names-same-birthday"));
check("a typo in a long name, same birthday, is found", pairOf([row("a", "Nana Yaw", "Boateng", "2013-07-21"), row("b", "Nana Yaw", "Boatang", "2013-07-21")])[0]?.endsWith("similar-name-same-birthday"));
check("same name and the same parent phone in another format is found", pairOf([row("a", "Efua", "Asare", "2016-01-01", ["0244123456"]), row("b", "Efua", "Asare", null, ["+233 24 412 3456"])])[0]?.endsWith("same-name-shared-parent-phone"));
check("(twins) Kofi and Kojo Mensah, born the same day, are not paired", pairOf([row("a", "Kofi", "Mensah", "2014-01-09"), row("b", "Kojo", "Mensah", "2014-01-09")]).length === 0);
check("(twins) Esi and Esie are too short to be matched on a slip", pairOf([row("a", "Esi", "Boateng", "2014-01-09"), row("b", "Esie", "Boateng", "2014-01-09")]).length === 0);
check("a one-letter slip in a long first name, same surname and birthday, is found", pairOf([row("a", "Abenaa", "Boateng", "2014-01-09"), row("b", "Abenaaa", "Boateng", "2014-01-09")]).length === 1);
check("short names two letters apart are NOT suggested (Ama / Ada)", pairOf([row("a", "Ama", "Lee", "2015-01-01"), row("b", "Ada", "Lee", "2015-01-01")]).length === 0);
check("two children with no birthday are never paired on that alone", pairOf([row("a", "Ama", "Owusu", null), row("b", "Ama", "Owusu", null)]).length === 0);
check("same name, different birthdays, no shared phone: not suggested", pairOf([row("a", "Ama", "Owusu", "2015-03-02", ["0244000001"]), row("b", "Ama", "Owusu", "2016-03-02", ["0244000002"])]).length === 0);
check("a pair is reported once, with its strongest reason", (() => { const p = findDuplicatePairs([row("a", "Ama", "Owusu", "2015-03-02", ["0244123456"]), row("b", "Ama", "Owusu", "2015-03-02", ["0244123456"])]); return p.length === 1 && p[0].reason === "same-name-and-birthday"; })());
check("helpers: editDistance, phoneKey, normaliseName", editDistance("kitten", "sitting", 5) === 3 && phoneKey("0244123456") === phoneKey("+233244123456") && normaliseName("  Édna  O'Brien ") === "edna obrien");

console.log("\nThe merge, rolled back");
class Rollback extends Error {}
const school = await demoSchool();
async function trial<T>(body: (tx: TenantTx) => Promise<T>): Promise<T> {
  const box: { value?: T } = {};
  try {
    await tenantTransaction(school.id, async (tx) => { box.value = await body(tx); throw new Rollback(); }, { timeout: 180_000, maxWait: 20_000 });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
  return box.value as T;
}
const tables = (tx: TenantTx, id: string) => async () => ({
  scores: await tx.score.count({ where: { studentId: id } }),
  invoices: await tx.invoice.count({ where: { studentId: id } }),
  payments: await tx.payment.count({ where: { studentId: id } }),
  results: await tx.termResult.count({ where: { studentId: id } }),
  register: await tx.attendanceEntry.count({ where: { studentId: id } }),
  guardians: await tx.studentGuardian.count({ where: { studentId: id } }),
  placements: await tx.enrollment.count({ where: { studentId: id } }),
});
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

// The pupil with the most history, so the merge has something to move.
const donor = await tenantTransaction(
  school.id,
  async (tx) => {
    // One grouped query, not a count per pupil: a loop over the roll outlives the transaction on a slow link.
    const top = await tx.score.groupBy({ by: ["studentId"], where: { schoolId: school.id }, _count: { _all: true }, orderBy: { _count: { studentId: "desc" } }, take: 10 });
    for (const t of top) {
      const live = await tx.student.findFirst({ where: { id: t.studentId, deletedAt: null }, select: { id: true } });
      if (live) return { id: live.id, n: sum(await tables(tx, live.id)()) };
    }
    return { id: "", n: 0 };
  },
  { timeout: 180_000, maxWait: 20_000 },
);
check("(control) the demo school has a pupil with history to move", donor.n > 0, `${donor.n} records`);

const clean = (tx: TenantTx) => tx.student.create({ data: { schoolId: school.id, admissionNo: `VERIFY-DUP-${Math.random().toString(36).slice(2, 8)}`, firstName: "Probe", lastName: "Keeper", gender: "FEMALE" } });

const plain = await trial(async (tx) => {
  const keep = await clean(tx);
  const before = await tables(tx, donor.id)();
  const res: MergeResult = await mergeStudents(tx, { schoolId: school.id, actorUserId: null, keepId: keep.id, removeId: donor.id });
  const after = await tables(tx, keep.id)();
  const left = await tables(tx, donor.id)();
  const gone = await tx.student.findUnique({ where: { id: donor.id }, select: { deletedAt: true } });
  const audit = await tx.auditLog.count({ where: { schoolId: school.id, action: "student.merge", entityId: keep.id } });
  return { res, before, after, left, gone, audit };
});
check("a merge into an empty record succeeds", plain.res.ok);
check("everything the removed record held is now on the kept one", JSON.stringify(plain.after) === JSON.stringify(plain.before), `${JSON.stringify(plain.after)}`);
check("and nothing is left on the removed one", sum(plain.left) === 0, JSON.stringify(plain.left));
check("the removed record is soft-deleted, not erased", plain.gone?.deletedAt != null);
check("the merge is written to the audit log", plain.audit === 1);

const conflicted = await trial(async (tx) => {
  const keep = await clean(tx);
  const theirs = await tx.score.findFirst({ where: { studentId: donor.id }, select: { assessmentId: true } });
  if (!theirs) return null;
  await tx.score.create({ data: { schoolId: school.id, assessmentId: theirs.assessmentId, studentId: keep.id, rawScore: 1 } });
  const before = { donor: await tables(tx, donor.id)(), keep: await tables(tx, keep.id)() };
  const res = await mergeStudents(tx, { schoolId: school.id, actorUserId: null, keepId: keep.id, removeId: donor.id });
  const after = { donor: await tables(tx, donor.id)(), keep: await tables(tx, keep.id)() };
  const gone = await tx.student.findUnique({ where: { id: donor.id }, select: { deletedAt: true } });
  return { res, before, after, gone };
});
if (!conflicted) {
  check("(control) the donor has a score to collide with", false);
} else {
  check("both records scored on the same assessment: REFUSED, naming the table", !conflicted.res.ok && conflicted.res.conflicts.some((c) => c.table === "Assessment scores"));
  check("and not one row moved, the removed record is not deleted", JSON.stringify(conflicted.after) === JSON.stringify(conflicted.before) && conflicted.gone?.deletedAt == null);
}

const overlap = await trial(async (tx) => {
  const link = await tx.studentGuardian.findFirst({ where: { studentId: donor.id }, select: { guardianId: true, relationship: true } });
  if (!link) return null;
  const keep = await clean(tx);
  await tx.studentGuardian.create({ data: { schoolId: school.id, studentId: keep.id, guardianId: link.guardianId, relationship: link.relationship, isPrimary: true } });
  const res = await mergeStudents(tx, { schoolId: school.id, actorUserId: null, keepId: keep.id, removeId: donor.id });
  const mine = await tx.studentGuardian.count({ where: { studentId: keep.id, guardianId: link.guardianId } });
  const primaries = await tx.studentGuardian.count({ where: { studentId: keep.id, isPrimary: true } });
  return { res, mine, primaries };
});
if (!overlap) {
  console.log("  --  the donor has no guardian link: the shared-parent case is skipped");
} else {
  check("a parent linked to both is not duplicated", overlap.res.ok && overlap.mine === 1);
  check("the kept record's primary parent stays primary", overlap.primaries === 1, `${overlap.primaries}`);
}

// A moved link must not become a second PRIMARY parent. Different parents on each record, both primary:
// the shared-parent case above drops a link rather than moving one, so it cannot show this.
const primary = await trial(async (tx) => {
  const keep = await clean(tx);
  const g1 = await tx.guardian.create({ data: { schoolId: school.id, firstName: "Probe", lastName: "ParentOne", phone: "0200000001" } });
  const g2 = await tx.guardian.create({ data: { schoolId: school.id, firstName: "Probe", lastName: "ParentTwo", phone: "0200000002" } });
  const dupe = await clean(tx);
  await tx.studentGuardian.create({ data: { schoolId: school.id, studentId: keep.id, guardianId: g1.id, relationship: "MOTHER", isPrimary: true } });
  await tx.studentGuardian.create({ data: { schoolId: school.id, studentId: dupe.id, guardianId: g2.id, relationship: "FATHER", isPrimary: true } });
  const res = await mergeStudents(tx, { schoolId: school.id, actorUserId: null, keepId: keep.id, removeId: dupe.id });
  return { res, links: await tx.studentGuardian.count({ where: { studentId: keep.id } }), primaries: await tx.studentGuardian.count({ where: { studentId: keep.id, isPrimary: true } }) };
});
check("different parents on each record: both are kept", primary.res.ok && primary.links === 2, `${primary.links}`);
check("and only ONE of them is the primary parent", primary.primaries === 1, `${primary.primaries}`);

const same = await trial(async (tx) => mergeStudents(tx, { schoolId: school.id, actorUserId: null, keepId: donor.id, removeId: donor.id }));
check("merging a record into itself is refused", !same.ok);

console.log("\nNothing was kept");
const kept = await tenantTransaction(school.id, async (tx) => ({
  donorLive: (await tx.student.findUnique({ where: { id: donor.id }, select: { deletedAt: true } }))?.deletedAt == null,
  probes: await tx.student.count({ where: { schoolId: school.id, admissionNo: { startsWith: "VERIFY-DUP-" } } }),
  merges: await tx.auditLog.count({ where: { schoolId: school.id, action: "student.merge" } }),
}));
check("the donor is still live, no probe pupil or merge audit row remains", kept.donorLive && kept.probes === 0 && kept.merges === 0, JSON.stringify(kept));

console.log("\nThe screen\'s loader, on a planted pair");
setTenantContext({ schoolId: school.id, readOnly: false });
const planted = `VERIFY-DUPCARD-${Date.now()}`;
try {
  await withOwner(async (db) => {
    const dob = new Date("2001-02-03T00:00:00Z");
    await db.student.create({ data: { schoolId: school.id, admissionNo: `${planted}-1`, firstName: "Zyxwv", lastName: "Qprobe", gender: "MALE", dateOfBirth: dob } });
    await db.student.create({ data: { schoolId: school.id, admissionNo: `${planted}-2`, firstName: "ZYXWV", lastName: "qprobe ", gender: "MALE", dateOfBirth: dob } });
  });
  const cards = await getDuplicateCards();
  const mine = cards.filter((c) => c.a.admissionNo.startsWith(planted) && c.b.admissionNo.startsWith(planted));
  check("the planted pair appears, once, as a very likely duplicate", mine.length === 1 && mine[0].pair.confidence === "high", `${mine.length}`);
  check("each side carries its counts and a suggestion to keep one of them", mine.length === 1 && Number.isInteger(mine[0].a.weight) && [mine[0].a.id, mine[0].b.id].includes(mine[0].suggestKeep));
  check("nothing else on the school is matched with it", cards.every((c) => !(c.a.admissionNo.startsWith(planted) !== c.b.admissionNo.startsWith(planted))));
} finally {
  await withOwner(async (db) => { await db.student.deleteMany({ where: { schoolId: school.id, admissionNo: { startsWith: planted } } }); });
}

console.log("\nWiring");
const action = code("src/lib/duplicate-actions.ts");
check("the merge action is leadership only", /requireRole\(LEADERSHIP\)/.test(action));
check("it reads both ids back through the tenant client before acting", /ownsStudents\(\[a, b\]\)/.test(action));
check("it refuses without the confirmation box", /confirm/.test(action) && /!== "yes"/.test(action));
check("the engine writes the audit action the dashboard has a phrase for", /"student\.merge"/.test(code("src/lib/student-merge.ts")) && /"student\.merge"/.test(code("src/lib/dashboard-data.ts")));

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

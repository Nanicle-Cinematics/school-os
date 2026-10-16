/**
 * Pupils on the roll with no class this year: the attention item and the Students filter must agree, and both
 * must count exactly the right people.
 *
 * One rule (`unplacedWhere`) answers "ACTIVE, not deleted, and no enrolment for the year that is not
 * WITHDRAWN". This plants one pupil of each kind in the demo school and reads the rule back through the
 * dashboard's attention card and through the Students list filter, against a recount made the long way:
 *   - live, no enrolment at all ............................ counted
 *   - live, only a WITHDRAWN enrolment this year ............ counted (not in any class)
 *   - live, an ACTIVE enrolment this year ................... NOT counted
 *   - deleted but still ACTIVE, no enrolment ................ NOT counted
 *   - status WITHDRAWN, no enrolment ........................ NOT counted
 * Development databases only; it writes through the owner connection and removes what it wrote.
 *
 * Run: npm run verify:unplaced
 */
import { getAttention, getDashboard } from "@/lib/dashboard-data";
import { getStudentList } from "@/lib/student-data";
import { setTenantContext } from "@/lib/tenant-context";
import { demoSchool, withOwner } from "./fixture.mjs";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

const school = await demoSchool();
setTenantContext({ schoolId: school.id, readOnly: false });
const dash = await getDashboard(school.id);
if (!dash.term) {
  console.log("no current term: nothing to check");
  process.exit(0);
}
const term = { id: dash.term.id, academicYearId: dash.term.academicYearId };
const fees = { outstanding: dash.outstanding, debtorCount: dash.debtorCount };
const tag = `VERIFY-UNP-${Date.now()}`;

const fromCard = async () => {
  const item = (await getAttention(school.id, term, fees)).find((i) => i.kind === "placement");
  const n = item ? Number(/^(\d+)/.exec(item.title)?.[1] ?? NaN) : 0;
  return { n, href: item?.href ?? null };
};
const fromList = async () => (await getStudentList({ placement: "none" })).matching;
const longWay = () =>
  withOwner(async (db) => {
    const live = await db.student.findMany({
      where: { schoolId: school.id, deletedAt: null, status: "ACTIVE" },
      select: { enrollments: { where: { academicYearId: term.academicYearId }, select: { status: true } } },
    });
    return live.filter((s) => !s.enrollments.some((e) => e.status !== "WITHDRAWN")).length;
  });

try {
  const baseline = { card: (await fromCard()).n, list: await fromList(), long: await longWay() };
  console.log("Before planting");
  check("the card, the filter and a long-way recount agree", baseline.card === baseline.long && baseline.list === baseline.long, `${baseline.card} / ${baseline.list} / ${baseline.long}`);

  await withOwner(async (db) => {
    const cls = await db.classGroup.findFirstOrThrow({ where: { schoolId: school.id }, select: { id: true } });
    const mk = (suffix: string, extra: object) =>
      db.student.create({ data: { schoolId: school.id, admissionNo: `${tag}-${suffix}`, firstName: "Probe", lastName: suffix, gender: "MALE", ...extra } });
    await mk("NOENROL", {});
    const w = await mk("WDENROL", {});
    await db.enrollment.create({ data: { schoolId: school.id, studentId: w.id, academicYearId: term.academicYearId, classGroupId: cls.id, status: "WITHDRAWN" } });
    const p = await mk("PLACED", {});
    await db.enrollment.create({ data: { schoolId: school.id, studentId: p.id, academicYearId: term.academicYearId, classGroupId: cls.id, status: "ACTIVE" } });
    await mk("DELETED", { deletedAt: new Date() });
    await mk("GONE", { status: "WITHDRAWN" });
  });

  const after = { card: await fromCard(), list: await fromList(), long: await longWay() };
  console.log("\nAfter planting one of each kind");
  check("two more are counted: no enrolment, and only a withdrawn one", after.long === baseline.long + 2, `${baseline.long} -> ${after.long}`);
  check("the attention card says the same number", after.card.n === after.long, `${after.card.n}`);
  check("the Students filter lists the same number", after.list === after.long, `${after.list}`);
  check("the card links to that filter", after.card.href === "/students?placement=none", `${after.card.href}`);
} finally {
  await withOwner(async (db) => {
    await db.student.deleteMany({ where: { schoolId: school.id, admissionNo: { startsWith: tag } } });
  });
}

const clean = { card: (await fromCard()).n, list: await fromList(), long: await longWay() };
console.log("\nAfter cleaning up");
check("back to where it started", clean.card === clean.long && clean.list === clean.long, `${clean.card} / ${clean.list} / ${clean.long}`);

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

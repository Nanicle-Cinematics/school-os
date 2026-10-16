/**
 * The dashboard's head-count must not include people the office has deleted.
 *
 * Deleting a pupil or a staff member sets `deletedAt` and leaves `status` ACTIVE, so a count on status alone
 * kept counting them: production's dashboard read 298 pupils while the Students page held 290. This plants a
 * deleted-but-ACTIVE pupil (and staff member) in the demo school, asks `getDashboard`, and compares with a
 * recount made the long way. Development databases only; it writes through the owner connection and removes
 * what it wrote.
 *
 * Run: npm run verify:dashboard-counts
 */
import { getDashboard } from "@/lib/dashboard-data";
import { withBypass } from "@/lib/tenant-context";
import { demoSchool, withOwner } from "./fixture.mjs";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

const school = await demoSchool();
const tag = `VERIFY-DEL-${Date.now()}`;
const read = () => withBypass(() => getDashboard(school.id));

try {
  const before = await read();
  await withOwner(async (db) => {
    await db.student.create({ data: { schoolId: school.id, admissionNo: tag, firstName: "Deleted", lastName: "Probe", gender: "MALE", status: "ACTIVE", deletedAt: new Date() } });
    await db.student.create({ data: { schoolId: school.id, admissionNo: `${tag}-F`, firstName: "Deleted", lastName: "ProbeF", gender: "FEMALE", status: "ACTIVE", deletedAt: new Date() } });
    await db.staff.create({ data: { schoolId: school.id, staffNo: tag, firstName: "Deleted", lastName: "Probe", gender: "MALE", status: "ACTIVE", deletedAt: new Date() } });
  });
  const after = await read();
  const recount = await withOwner(async (db) => ({
    students: await db.student.count({ where: { schoolId: school.id, status: "ACTIVE", deletedAt: null } }),
    staff: await db.staff.count({ where: { schoolId: school.id, status: "ACTIVE", deletedAt: null } }),
    deletedActive: await db.student.count({ where: { schoolId: school.id, status: "ACTIVE", deletedAt: { not: null } } }),
  }));

  console.log("Deleted-but-ACTIVE people are not counted");
  check("(control) the database really holds deleted pupils that are still ACTIVE", recount.deletedActive >= 2, `${recount.deletedActive}`);
  check("pupils: planting deleted ones changes nothing", after.students === before.students, `${before.students} -> ${after.students}`);
  check("boys and girls: likewise", after.boys === before.boys && after.girls === before.girls, `${before.boys}/${before.girls} -> ${after.boys}/${after.girls}`);
  check("staff: likewise", after.staff === before.staff, `${before.staff} -> ${after.staff}`);
  check("the dashboard agrees with a recount made the long way", after.students === recount.students && after.staff === recount.staff, `${after.students}/${after.staff} vs ${recount.students}/${recount.staff}`);
} finally {
  await withOwner(async (db) => {
    await db.student.deleteMany({ where: { schoolId: school.id, admissionNo: { startsWith: tag } } });
    await db.staff.deleteMany({ where: { schoolId: school.id, staffNo: tag } });
  });
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

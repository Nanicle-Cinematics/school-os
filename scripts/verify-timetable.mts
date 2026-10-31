/**
 * The timetable's rules, and the shape of the code around them.
 *
 *   npm run verify:timetable
 *
 * No database and no server. The rules are the pure functions in
 * `src/lib/timetable-rules.ts`, which the routes, the pages and the browser all
 * run; the shape checks read the source (comments stripped, since this codebase
 * explains its mistakes at length and a comment naming a rule would satisfy a
 * check that the rule is not there). `verify:timetable-route` drives the real
 * routes against the database.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAX_PERIODS,
  STANDARD_DAY,
  checkPeriods,
  clashes,
  findTeacherClash,
  formatRange,
  isWeekday,
  lessonCounts,
  nextLessonPeriod,
  normaliseTime,
  parseSlotRequest,
  parseTime,
  teachersFor,
  type PlacedLesson,
} from "@/lib/timetable-rules";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  if (!ok) failures += 1;
}

const root = resolve(import.meta.dirname, "..");
const code = (file: string) =>
  readFileSync(resolve(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const row = (label: string, startTime: string, endTime: string, isBreak = false) => ({ label, startTime, endTime, isBreak });

console.log("Times");
{
  check("08:05 is a time", parseTime("08:05") === 8 * 60 + 5);
  check("23:59 is, 24:00 is not", parseTime("23:59") === 1439 && parseTime("24:00") === null);
  check("8:05 is not a time until it is normalised", parseTime("8:05") === null && normaliseTime("8:5") === "08:05");
  check("rubbish is not a time", parseTime("noon") === null && parseTime("08:60") === null && parseTime("") === null);
  check("a range prints with an en dash", formatRange({ startTime: "08:00", endTime: "08:40" }) === "08:00–08:40");
}

console.log("\nWhether a list of periods is a day");
{
  const ok = checkPeriods([row("Period 1", "08:00", "08:40"), row("Break", "08:40", "09:00", true), row("Period 2", "09:00", "09:40")]);
  check("a sensible day is accepted", ok.ok);
  check("times typed as 8:00 are stored as 08:00", ok.ok && ok.rows[0]!.startTime === "08:00" && checkPeriods([row("A", "8:00", "8:40")]).ok);
  const standard = checkPeriods(STANDARD_DAY);
  check("the standard day is itself a valid day", standard.ok, JSON.stringify(standard));
  check("the standard day has seven lessons and two breaks", STANDARD_DAY.filter((p) => !p.isBreak).length === 7 && STANDARD_DAY.filter((p) => p.isBreak).length === 2);
  check("an empty day is refused", !checkPeriods([]).ok);
  check("a day of only breaks is refused", !checkPeriods([row("Break", "08:00", "08:30", true)]).ok);
  check("a period that ends before it starts is refused", !checkPeriods([row("A", "09:00", "08:00")]).ok);
  check("a period that ends when it starts is refused", !checkPeriods([row("A", "09:00", "09:00")]).ok);
  check("a period that starts before the one above ends is refused", !checkPeriods([row("A", "08:00", "09:00"), row("B", "08:30", "09:30")]).ok);
  check("a period that starts exactly when the last ended is fine", checkPeriods([row("A", "08:00", "09:00"), row("B", "09:00", "10:00")]).ok);
  check("a bad time is refused, in words", (() => { const r = checkPeriods([row("A", "8am", "9:00")]); return !r.ok && /not a time/.test(r.errors.join(" ")); })());
  check("no name is refused", !checkPeriods([row("", "08:00", "08:40")]).ok);
  check("two rows with the same name are refused", !checkPeriods([row("Period 1", "08:00", "08:40"), row("period 1", "08:40", "09:20")]).ok);
  check(`more than ${MAX_PERIODS} rows is refused`, !checkPeriods(Array.from({ length: MAX_PERIODS + 1 }, (_, i) => row(`P${i}`, `${String(6 + i).padStart(2, "0")}:00`, `${String(6 + i).padStart(2, "0")}:30`))).ok);
  const many = checkPeriods([row("A", "09:00", "08:00"), row("", "x", "y")]);
  check("every complaint comes back at once, not the first", !many.ok && many.errors.length >= 3, many.ok ? "" : String(many.errors.length));
}

console.log("\nA double lesson");
{
  const day = [
    { id: "p1", order: 1, isBreak: false },
    { id: "p2", order: 2, isBreak: false },
    { id: "b", order: 3, isBreak: true },
    { id: "p3", order: 4, isBreak: false },
  ];
  check("period 1 runs into period 2", nextLessonPeriod(day, "p1")?.id === "p2");
  check("period 2 cannot run into the break", nextLessonPeriod(day, "p2") === null);
  check("the last period of the day has nothing after it", nextLessonPeriod(day, "p3") === null);
  check("an unknown period has no next", nextLessonPeriod(day, "zzz") === null);
  check("the day is read in order whatever order it arrives in", nextLessonPeriod([...day].reverse(), "p1")?.id === "p2");
}

console.log("\nWho teaches it, and who is in two places");
{
  const assignments = [
    { staffId: "ama", classGroupId: "b5", subjectId: "math" },
    { staffId: "ama", classGroupId: "b6", subjectId: "math" },
    { staffId: "kofi", classGroupId: "b5", subjectId: "eng" },
    { staffId: "yaw", classGroupId: "b5", subjectId: "eng" },
  ];
  check("the teacher is whoever holds the assignment", teachersFor(assignments, "b5", "math").join() === "ama");
  check("two people can share a subject", teachersFor(assignments, "b5", "eng").length === 2);
  check("a subject nobody is assigned has no teacher", teachersFor(assignments, "b6", "eng").length === 0);

  const lesson = (classGroupId: string, subjectId: string, weekday: number, periodId: string): PlacedLesson => ({
    classGroupId,
    classLabel: classGroupId.toUpperCase(),
    subjectId,
    weekday,
    periodId,
    staffIds: teachersFor(assignments, classGroupId, subjectId),
  });
  const placed = [lesson("b6", "math", 1, "p1")];

  const clash = findTeacherClash({ classGroupId: "b5", weekday: 1, periodId: "p1", staffIds: ["ama"] }, placed);
  check("Ama cannot teach B5 at Monday period 1 while she is in B6", clash?.staffId === "ama" && clash.lesson.classGroupId === "b6");
  check("another weekday is fine", findTeacherClash({ classGroupId: "b5", weekday: 2, periodId: "p1", staffIds: ["ama"] }, placed) === null);
  check("another period is fine", findTeacherClash({ classGroupId: "b5", weekday: 1, periodId: "p2", staffIds: ["ama"] }, placed) === null);
  check("a different teacher is fine", findTeacherClash({ classGroupId: "b5", weekday: 1, periodId: "p1", staffIds: ["kofi"] }, placed) === null);
  check("replacing a class's OWN lesson is not a clash with itself", findTeacherClash({ classGroupId: "b6", weekday: 1, periodId: "p1", staffIds: ["ama"] }, placed) === null);
  check("a subject with no teacher cannot clash", findTeacherClash({ classGroupId: "b5", weekday: 1, periodId: "p1", staffIds: [] }, placed) === null);
  check("a shared subject clashes if either teacher is busy", findTeacherClash({ classGroupId: "b5", weekday: 1, periodId: "p1", staffIds: ["kofi", "ama"] }, placed)?.staffId === "ama");

  const found = clashes([lesson("b5", "math", 1, "p1"), lesson("b6", "math", 1, "p1"), lesson("b5", "eng", 2, "p1")]);
  check("a clash that exists after an assignment is edited is still found on read", found.length === 1 && found[0]!.staffId === "ama" && found[0]!.classGroupIds.join() === "b5,b6");
  check("no lessons, no clashes", clashes([]).length === 0);
  check("a class's own two lessons at different times are not a clash", clashes([lesson("b5", "math", 1, "p1"), lesson("b5", "math", 1, "p2")]).length === 0);

  const counts = lessonCounts([{ subjectId: "math" }, { subjectId: "math" }, { subjectId: "eng" }]);
  check("lessons per subject are counted", counts.get("math") === 2 && counts.get("eng") === 1 && counts.get("sci") === undefined);
}

console.log("\nWhat a post may ask for");
{
  const good = { classGroupId: "c1", weekday: 3, periodId: "p1", subjectId: "math", double: false };
  check("a lesson is accepted", parseSlotRequest(good).ok);
  check("an empty subject clears the lesson", parseSlotRequest({ ...good, subjectId: "" }).ok);
  check("a double of nothing is refused", !parseSlotRequest({ ...good, subjectId: "", double: true }).ok);
  check("a weekend is not a weekday", !isWeekday(6) && !isWeekday(0) && !parseSlotRequest({ ...good, weekday: 6 }).ok);
  check("a weekday must be a whole number", !isWeekday(2.5) && !isWeekday("2") && !parseSlotRequest({ ...good, weekday: "2" }).ok);
  check("no class, no period: refused", !parseSlotRequest({ ...good, classGroupId: "" }).ok && !parseSlotRequest({ ...good, periodId: undefined }).ok);
  check("an oversized id is refused", !parseSlotRequest({ ...good, classGroupId: "x".repeat(65) }).ok);
  check("not an object is refused", !parseSlotRequest(null).ok && !parseSlotRequest("x").ok);
  check("double must be a boolean", !parseSlotRequest({ ...good, double: "yes" }).ok);
}

console.log("\nThe shape of the code");
{
  const engine = code("src/lib/timetable-engine.ts");
  const periods = code("src/lib/timetable-periods.ts");
  const slotRoute = code("src/app/api/timetable/slot/route.ts");
  const periodsRoute = code("src/app/api/timetable/periods/route.ts");
  const data = code("src/lib/timetable-data.ts");
  const page = code("src/app/(app)/timetable/page.tsx");
  const schema = readFileSync(resolve(root, "prisma/schema.prisma"), "utf8");
  const slotModel = schema.slice(schema.indexOf("model TimetableSlot"), schema.indexOf("}", schema.indexOf("model TimetableSlot")));

  check("a lesson stores NO teacher: it would go stale the day an assignment changes", !/staffId|teacherId|staff\b/.test(slotModel.replace(/\/\/\/.*$/gm, "")), slotModel);
  check("a class has one lesson per weekday and period, enforced by the database", /@@unique\(\[classGroupId, academicYearId, weekday, periodId\]\)/.test(slotModel));
  check("a period with lessons cannot be deleted from under them", /onDelete: Restrict/.test(slotModel));
  check("both new tables carry a school", /schoolId/.test(slotModel) && /model TimetablePeriod[\s\S]{0,300}schoolId/.test(schema));

  check("both routes check the role BEFORE they read the body", [slotRoute, periodsRoute].every((r) => r.indexOf("requireRole(TIMETABLE_EDIT)") > 0 && r.indexOf("requireRole(TIMETABLE_EDIT)") < r.indexOf("request.text()")));
  check("and set the tenant before touching data", [slotRoute, periodsRoute].every((r) => r.indexOf("setTenantContext(auth.tenant)") > 0 && r.indexOf("setTenantContext(auth.tenant)") < r.search(/placeLesson\(|replacePeriods\(|applyStandardDay\(/)));
  check("they refuse a body that is not JSON, or from another site", [slotRoute, periodsRoute].every((r) => /415/.test(r) && /sec-fetch-site/.test(r)));
  check("editing is for the head: not the office, not a teacher", /TIMETABLE_EDIT:\s*Role\[\]\s*=\s*LEADERSHIP/.test(code("src/lib/permissions.ts")));

  check("the class is read back through the tenant client before it is written", /ownsClasses\(\[request\.classGroupId\]\)/.test(engine));
  check("the subject must be one the class's LEVEL offers", /levelSubject\.findFirst\(\{[\s\S]{0,200}levelId:\s*classGroup\.levelId/.test(engine));
  check("a break cannot be given a lesson", /if \(period\.isBreak\) \{\s*return \{ error/.test(engine));
  check("the teacher check and the write share one transaction under a lock", /tenantTransaction\([\s\S]*await tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(hashtext\([\s\S]*findTeacherClash[\s\S]*timetableSlot\.upsert/.test(engine));
  check("the teacher is worked out from the year's assignments, never stored", /teachersFor\(assignments/.test(engine) && !/staffId:\s*staffIds/.test(engine));
  check("a double lesson is refused whole before anything is written", engine.indexOf("nextLessonPeriod(") > 0 && engine.indexOf("nextLessonPeriod(") < engine.indexOf("tenantTransaction("));
  check("only the current year is edited", /isCurrent:\s*true/.test(engine));

  check("periods are moved out of range before they are renumbered ((school, order) is unique)", /OFFSET[\s\S]{0,200}increment/.test(periods));
  check("a period holding lessons can neither be removed nor become a break", /cannot be removed/.test(periods) && /cannot become a break/.test(periods));
  check("a period id from the request is one of this school's own", /known\.has\(id\)/.test(periods));
  check("provisioning gives a new school the standard day", /timetablePeriod\.createMany\(\{ data: standardDayRows/.test(code("src/lib/provisioning.ts")));

  check("a teacher is shown THEIR week from the session's staff id, never one in the URL", /auth\.staffId \? await getTeacherWeek\(auth\.staffId\)/.test(page) && !/query\.staff[\s\S]{0,80}teacherOnly/.test(page));
  check("and the office's choice of teacher must be one it was offered", /options\.find\(\(t\) => t\.id === wanted\)/.test(page));
  check("the timetable page asks for TIMETABLE_VIEW and the school-day page for TIMETABLE_EDIT", /requireRole\(TIMETABLE_VIEW\)/.test(page) && /requireRole\(TIMETABLE_EDIT\)/.test(code("src/app/(app)/timetable/periods/page.tsx")));
  check("the data layer reads the clock nowhere (the page is dynamic, nothing is cached by date)", !/Date\.now\(\)|new Date\(\)/.test(data));
  check("the activity feed has words for both audited actions", /"timetable\.slot":/.test(code("src/lib/dashboard-data.ts")) && /"timetable\.periods":/.test(code("src/lib/dashboard-data.ts")));
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

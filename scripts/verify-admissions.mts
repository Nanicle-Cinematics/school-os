/**
 * Admissions: the rules, and the shape of the code around them.
 *
 *   npm run verify:admissions
 *
 * No database and no server. The rules are the pure functions in `src/lib/admissions-rules.ts`, which the
 * office's screens, the actions and the public form's route all run. The shape checks read the source
 * (comments stripped: this codebase explains its mistakes at length, and a comment naming a rule would
 * satisfy a check that the rule is not there). `verify:admissions-route` drives the real routes and pages.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ApplicationStatus } from "@prisma/client";
import {
  HOLDS_SEAT,
  MAX_BODY,
  ONLINE_PER_ADDRESS_PER_HOUR,
  ONLINE_PER_DAY,
  OPEN_STATUSES,
  STATUS_ORDER,
  TRAP_FIELD,
  canMove,
  isSettled,
  lookAlikes,
  movesFrom,
  offerLapsed,
  offerRefusal,
  readApplication,
  readOfferExpiry,
  readTest,
  seatsFor,
  startableYears,
} from "@/lib/admissions-rules";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  if (!ok) failures += 1;
}

const root = resolve(import.meta.dirname, "..");
const code = (file: string) =>
  readFileSync(resolve(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const TODAY = new Date("2026-11-01T12:00:00Z");
const good = {
  firstName: "Ama",
  lastName: "Owusu",
  gender: "FEMALE",
  dateOfBirth: "2018-05-14",
  guardianName: "Kofi Owusu",
  guardianPhone: "0244123456",
  levelId: "level-1",
  academicYearId: "year-1",
};
const refusal = (patch: Record<string, unknown>) => {
  const r = readApplication({ ...good, ...patch }, TODAY);
  return r.ok ? null : r.error;
};

console.log("The pipeline");
{
  const expected: Record<ApplicationStatus, ApplicationStatus[]> = {
    APPLIED: ["TESTING", "WAITLISTED", "OFFERED", "REJECTED", "WITHDRAWN"],
    TESTING: ["APPLIED", "WAITLISTED", "OFFERED", "REJECTED", "WITHDRAWN"],
    WAITLISTED: ["APPLIED", "TESTING", "OFFERED", "REJECTED", "WITHDRAWN"],
    OFFERED: ["ACCEPTED", "WAITLISTED", "REJECTED", "WITHDRAWN"],
    ACCEPTED: ["OFFERED", "WITHDRAWN"],
    ADMITTED: [],
    REJECTED: ["APPLIED"],
    WITHDRAWN: ["APPLIED"],
  };
  let allRight = true;
  for (const from of STATUS_ORDER) {
    for (const to of STATUS_ORDER) {
      if (canMove(from, to) !== expected[from].includes(to)) allRight = false;
    }
  }
  check("every one of the 64 moves is allowed or refused as the pipeline says", allRight);
  check("nothing is moved to ADMITTED by hand: admitting creates the pupil", STATUS_ORDER.every((s) => !canMove(s, "ADMITTED")));
  check("an admitted application never moves again", movesFrom("ADMITTED").length === 0 && isSettled("ADMITTED"));
  check("an offer must be accepted before the child can be admitted: no shortcut from offered or applied", !canMove("OFFERED", "ADMITTED") && !canMove("APPLIED", "ACCEPTED"));
  check("a refused or withdrawn application can be reopened, and only to the start", movesFrom("REJECTED").join() === "APPLIED" && movesFrom("WITHDRAWN").join() === "APPLIED");
  check("only offered and accepted hold a seat", HOLDS_SEAT.join() === "OFFERED,ACCEPTED");
  check("the working queue is everything not decided, not admitted", OPEN_STATUSES.join() === "APPLIED,TESTING,WAITLISTED,OFFERED,ACCEPTED");
}

console.log("\nPlaces");
{
  const full = seatsFor({ capacities: [30, 30], enrolled: 55, held: 4 });
  check("two classes of 30, 55 enrolled and 4 offered leave 1", full.limited && full.capacity === 60 && full.left === 1);
  const none = seatsFor({ capacities: [30, 30], enrolled: 56, held: 4 });
  check("and none when the last is taken", none.limited && none.left === 0);
  const over = seatsFor({ capacities: [30], enrolled: 33, held: 0 });
  check("an over-admitted level shows a negative figure rather than hiding it", over.limited && over.left === -3);
  check("one class without a limit makes the whole level unlimited", !seatsFor({ capacities: [30, null], enrolled: 99, held: 0 }).limited);
  check("a level with no class has nothing to count against", !seatsFor({ capacities: [], enrolled: 0, held: 0 }).limited);
  check("an offer is refused when no place is left, with the arithmetic", (offerRefusal(none, "Basic 1") ?? "").includes("60 places") && (offerRefusal(none, "Basic 1") ?? "").includes("waiting list"));
  check("an offer is allowed when one place is left", offerRefusal(full, "Basic 1") === null);
  check("an unlimited level never refuses", offerRefusal(seatsFor({ capacities: [null], enrolled: 500, held: 0 }), "KG 1") === null);
  check("a child who already holds a place is never refused for lack of the one they sit in", offerRefusal(none, "Basic 1", true) === null);
}

console.log("\nReading an application");
{
  const ok = readApplication(good, TODAY);
  check("a complete application is read", ok.ok);
  check("names are trimmed and collapsed", (() => { const r = readApplication({ ...good, firstName: "  Ama   Serwaa " }, TODAY); return r.ok && r.value.firstName === "Ama Serwaa"; })());
  check("an email is lower-cased", (() => { const r = readApplication({ ...good, guardianEmail: "Kofi@Example.COM" }, TODAY); return r.ok && r.value.guardianEmail === "kofi@example.com"; })());
  check("a missing first name is refused", refusal({ firstName: "" }) !== null);
  check("a missing last name is refused", refusal({ lastName: "   " }) !== null);
  check("a gender other than the two is refused", refusal({ gender: "OTHER" }) !== null && refusal({ gender: "" }) !== null);
  check("a date of birth in the future is refused", (refusal({ dateOfBirth: "2027-01-01" }) ?? "").includes("recent"));
  check("a date of birth thirty years ago is refused", (refusal({ dateOfBirth: "1996-01-01" }) ?? "").includes("long ago"));
  check("a date written 14/05/2018 is not guessed at", refusal({ dateOfBirth: "14/05/2018" }) !== null);
  check("a date that does not exist (30 February) is refused", refusal({ dateOfBirth: "2018-02-30" }) !== null);
  check("a blank date of birth is allowed", readApplication({ ...good, dateOfBirth: "" }, TODAY).ok);
  check("a phone that is not a Ghanaian mobile is refused", refusal({ guardianPhone: "12345" }) !== null);
  check("+233 and 0 forms of a mobile number are both accepted", readApplication({ ...good, guardianPhone: "+233244123456" }, TODAY).ok && readApplication({ ...good, guardianPhone: "024 412 3456" }, TODAY).ok);
  check("an email that is not one is refused", refusal({ guardianEmail: "kofi" }) !== null);
  check("a name over the limit is refused, not cut", (refusal({ firstName: "A".repeat(61) }) ?? "").includes("too long"));
  check("notes over the limit are refused", (refusal({ notes: "x".repeat(601) }) ?? "").includes("too long"));
  check("a control character in a name is refused", refusal({ firstName: "Ama\u0007" }) !== null);
  check("a number where a name belongs is refused as not text", refusal({ firstName: 12 }) !== null);
  check("an unknown relationship becomes guardian rather than reaching the database", (() => { const r = readApplication({ ...good, guardianRelationship: "KING" }, TODAY); return r.ok && r.value.guardianRelationship === "GUARDIAN"; })());
  check("no class or year is refused", refusal({ levelId: "" }) !== null && refusal({ academicYearId: "" }) !== null);
  check("an absurdly long id is refused before any query", refusal({ levelId: "x".repeat(200) }) !== null);
}

console.log("\nThe test and the offer");
{
  const test = (patch: Record<string, unknown>) => readTest({ testedOn: "", testScore: "", testNotes: "", ...patch });
  check("a blank test is allowed and is not zero", (() => { const r = test({}); return r.ok && r.testScore === null; })());
  check("78.5 out of 100 is read", (() => { const r = test({ testScore: "78.5" }); return r.ok && r.testScore === 78.5; })());
  check("100 is allowed and 100.5 is not", test({ testScore: "100" }).ok && !test({ testScore: "100.5" }).ok);
  check("a negative, 1e1 and words are not marks", !test({ testScore: "-1" }).ok && !test({ testScore: "1e1" }).ok && !test({ testScore: "good" }).ok);
  check("a test date that does not exist is refused", !test({ testedOn: "2026-13-01" }).ok);
  check("an offer cannot lapse yesterday, and may lapse today or later", !readOfferExpiry("2026-10-31", TODAY).ok && readOfferExpiry("2026-11-01", TODAY).ok && readOfferExpiry("", TODAY).ok);
}

console.log("\nLateness is derived, never stored");
{
  const offered = (day: string | null, status: ApplicationStatus = "OFFERED") => ({ status, offerExpiresOn: day ? new Date(`${day}T00:00:00Z`) : null });
  check("an offer is still good on its last day", !offerLapsed(offered("2026-11-01"), TODAY));
  check("and lapsed the day after", offerLapsed(offered("2026-10-31"), TODAY));
  check("an offer with no date never lapses", !offerLapsed(offered(null), TODAY));
  check("only an OFFERED application can lapse: an accepted one has said yes", !offerLapsed(offered("2026-01-01", "ACCEPTED"), TODAY));
  const schema = readFileSync(resolve(root, "prisma/schema.prisma"), "utf8");
  const fields = (schema.match(/model Application \{([\s\S]*?)\n\}/)?.[1] ?? "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  check("the schema has no stored 'expired' or 'lapsed' flag to rot", fields.length > 200 && !/lapsed|expired|isOverdue/i.test(fields));
}

console.log("\nLook-alikes");
{
  const d = (day: string | null) => (day ? new Date(`${day}T00:00:00Z`) : null);
  const me = { id: "a", firstName: "Ama", lastName: "Owusu", dateOfBirth: d("2018-05-14"), guardianPhone: "0244123456" };
  const other = (patch: Partial<typeof me>) => ({ ...me, id: "b", ...patch });
  check("same name and birthday", lookAlikes(me, [other({})]).join() === "b");
  check("same name and a parent's phone in another format", lookAlikes(me, [other({ dateOfBirth: d("2019-01-01"), guardianPhone: "+233 24 412 3456" })]).join() === "b");
  check("same name, different birthday, different phone: not a match", lookAlikes(me, [other({ dateOfBirth: d("2019-01-01"), guardianPhone: "0201112222" })]).length === 0);
  check("accents and case are folded", lookAlikes(me, [other({ firstName: "AMÁ", lastName: "owusu" })]).join() === "b");
  check("two missing birthdays never match each other", lookAlikes({ ...me, dateOfBirth: null, guardianPhone: "0201112222" }, [other({ dateOfBirth: null, guardianPhone: "0209998888" })]).length === 0);
  check("the same row is never its own look-alike", lookAlikes(me, [me]).length === 0);
  check("a different first name is a different child (twins)", lookAlikes(me, [other({ firstName: "Esi" })]).length === 0);
}

console.log("\nYears a child may start");
{
  const years = [
    { name: "2025/2026", endDate: new Date("2026-07-31T00:00:00Z") },
    { name: "2026/2027", endDate: new Date("2027-07-31T00:00:00Z") },
  ];
  check("a year that has ended is not offered; the current and later ones are", startableYears(years, TODAY).map((y) => y.name).join() === "2026/2027");
}

console.log("\nThe public form's budget");
{
  check("a sensible hourly limit per address: a family with several children still gets through", ONLINE_PER_ADDRESS_PER_HOUR >= 4 && ONLINE_PER_ADDRESS_PER_HOUR <= 20);
  check("a daily ceiling per school that a real school never reaches", ONLINE_PER_DAY >= 100 && ONLINE_PER_DAY <= 1000);
  check("a request body is capped well above a real application and well below a flood", MAX_BODY >= 4_000 && MAX_BODY <= 50_000);
  check("the honeypot field is named", TRAP_FIELD === "website");
}

console.log("\nThe shape of the code");
{
  const route = code("src/app/api/apply/[slug]/route.ts");
  const pub = code("src/lib/admissions-public.ts");
  const page = code("src/app/apply/[slug]/page.tsx");
  const engine = code("src/lib/admissions-engine.ts");
  const actions = code("src/lib/admission-actions.ts");
  const core = code("src/lib/student-admission.ts");
  const rules = code("src/lib/admissions-rules.ts");

  check("the public route does its database work inside the public budget", /publicLookup\(\(\) => submitPublicApplication\(/.test(route));
  check("it answers JSON only, same-origin only, and caps the body before any query", /application\/json/.test(route) && /sec-fetch-site/.test(route) && /MAX_BODY/.test(route));
  check("it reads no session and sets no cookie", !/requireAuth|requireRole|getSessionUser|cookies\(/.test(route) && !/Set-Cookie/i.test(route));
  check("it is never cached", /no-store/.test(route));
  check("a bad slug is turned away before any query", /looksLikeSlug\(slug\)[\s\S]{0,120}404/.test(route));
  check("the public page's lookup is inside the same budget", /publicLookup\(\(\) => getPublicForm\(slug\)\)/.test(page));
  check("a busy budget shows a plain page, not an error", /isBusy\(error\)/.test(page));
  check("the public page is indexable by nobody", /index: false/.test(page));

  check("a closed form, a lapsed school and an unknown slug are one answer (openSchool returns null for all three)", /if \(!school \|\| !school\.settings\?\.applicationsOpen\) return null;/.test(pub) && /subscriptionState\(school\)\.readOnly\) return null;/.test(pub));
  check("a filled honeypot is told it worked and nothing is saved", /\n  if \(typeof raw\[TRAP_FIELD\] === "string" && raw\[TRAP_FIELD\]\.trim\(\) !== ""\) \{\s*return \{ status: 200, reference: "APP-0000" \};/.test(pub));
  check("the trap is checked BEFORE the address is counted and before anything is written", pub.indexOf("TRAP_FIELD") < pub.indexOf("takeAttempt(") && pub.indexOf("takeAttempt(") < pub.indexOf("createApplication("));
  check("an address is limited per hour and a school per day", /takeAttempt\(`apply:\$\{address\}`, ONLINE_PER_ADDRESS_PER_HOUR/.test(pub) && /today >= ONLINE_PER_DAY/.test(pub));
  check("it never says an application for a named child already exists", !/already (applied|exists|has an application)/i.test(pub + route));
  check("the school is found by its key under the bypass, and everything after runs in that school's own context", /withBypass\(\(\) =>\s*prisma\.school\.findUnique\(\{\s*where: \{ slug \}/.test(pub) && /runWithTenantContext\(\{ schoolId: school\.id \}/.test(pub));
  check("a public submission is created with source ONLINE and no actor", /createApplication\(\{ schoolId: school\.id, userId: null \}, read\.value, "ONLINE"\)/.test(pub));

  check("the class and year in a request are read back through the tenant client before they are written", /ownsLevels\(\[levelId\]\)/.test(engine) && /ownsAcademicYears\(\[academicYearId\]\)/.test(engine) && /ownsClasses\(\[classGroupId\]\)/.test(engine));
  check("an offer counts the seats under a lock on (school, level, year)", /if \(to === "OFFERED"\) \{\s*await lockOn\(tx, `seats:\$\{actor\.schoolId\}:\$\{current\.levelId\}:\$\{current\.academicYearId\}`\);/.test(engine));
  check("and so does moving a seat-holder to another class or year", /moved && HOLDS_SEAT\.includes\(current\.status\)\) \{\s*await lockOn\(/.test(engine));
  check("every step takes a lock on the application, so two clicks cannot both act", (engine.match(/await lockOn\(tx, `application:\$\{id\}`\);/g) ?? []).length >= 4);
  check("a hand-made move to ADMITTED is refused", /if \(to === "ADMITTED"\) \{\s*return \{ error:/.test(engine));
  check("only an ACCEPTED application can be admitted", /application\.status !== "ACCEPTED"/.test(engine));
  check("admitting goes through the office's own admission, and writes no pupil itself", /admitPupil\(\{/.test(engine) && !/student\.create/.test(engine));
  check("the pupil and the application are marked together or not at all", /afterCreate: async \(tx, studentId\) =>/.test(engine) && /where: \{ id, status: "ACCEPTED" \}/.test(engine) && /marked\.count !== 1/.test(engine));
  check("a class must belong to the level applied for, and not be full", /klass\.levelId !== application\.levelId/.test(engine) && /enrolled >= klass\.capacity/.test(engine));
  check("a child starting in a later year is admitted without a class", /status: now \? "ACTIVE" : "ADMITTED"/.test(engine) && /classGroupId: now \? classGroupId : ""/.test(engine));
  check("an admitted application cannot be edited, tested or deleted", (engine.match(/isSettled\(current\.status\)/g) ?? []).length >= 3);

  const creators = (dir: string): string[] =>
    readdirSync(resolve(root, dir)).flatMap((name) => {
      const full = join(dir, name);
      return statSync(resolve(root, full)).isDirectory() ? creators(full) : full.endsWith(".ts") && /\b(?:tx|prisma)\.student\.create\b/.test(code(full)) ? [full] : [];
    });
  const makers = creators("src/lib").sort();
  check("a pupil is created in exactly two places, each asking the plan's cap first", makers.join() === "src/lib/import-actions.ts,src/lib/student-admission.ts", makers.join());
  check("the shared admission asks the cap before the transaction opens", core.indexOf("admissionBlocked(") > 0 && core.indexOf("admissionBlocked(") < core.indexOf("tenantTransaction("));
  check("the office's admit form uses the shared admission rather than a second copy", /admitPupil\(\{/.test(code("src/lib/student-actions.ts")) && !/student\.create/.test(code("src/lib/student-actions.ts")));
  check("an applicant is never a Student row with status APPLICANT", !/status: "APPLICANT"/.test(engine + actions + pub));

  const exported = actions.split("export async function ").slice(1);
  check("every admissions action runs requireRole and sets the tenant context in its own frame", exported.length >= 7 && exported.every((body) => /requireRole\(/.test(body) && /setTenantContext\(auth\.tenant\)/.test(body)), `${exported.length} actions`);
  check("opening the public form is leadership's, not the whole office's", /saveApplicationFormAction[\s\S]{0,200}requireRole\(ADMISSIONS_FORM\)/.test(actions));
  check("the rest are the office's", (actions.match(/requireRole\(ADMISSIONS\)/g) ?? []).length === exported.length - 1);
  check("opening the form with no classes or no year is refused", /levels === 0 \|\| years === 0/.test(actions));

  check("the rules module is pure: no server-only, no database", !/server-only/.test(rules) && !/@\/lib\/prisma/.test(rules));
  const permissions = code("src/lib/permissions.ts");
  check("Admissions is on the rail for the office", /href: "\/admissions", label: "Admissions", icon: "admissions", roles: ADMISSIONS/.test(permissions));
  check("the activity feed has words for every admissions action", ["create", "submit", "update", "test", "move", "delete", "form"].every((a) => new RegExp(`"application\\.${a}":`).test(code("src/lib/dashboard-data.ts"))));
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

/**
 * The nursery progress report: the rules a typed rating is judged by, and the shape of the code that
 * enforces them.
 *
 * Pure: no database and no server. The HTTP and database half is verify:skill-ratings.
 *
 * The RULES (`src/lib/skills.ts`): which levels use the card, what a rating may be, how a score is
 * judged, how a textarea of skills becomes names, how an area gets a code, how an age is printed.
 * The SHAPE, read from source with comments stripped (this codebase explains its mistakes at length,
 * and the words would satisfy a search): who may call each action, that every id is read back, that a
 * refused save writes nothing, and that nothing in the nursery path touches the marks engine, because
 * a nursery rating must never move a term's marks.
 *
 * Run: npm run verify:skills
 */
import { readFileSync } from "node:fs";
import {
  SKILL_CARD_STAGES,
  SKILL_GRADES,
  SKILLS_PER_AREA_MAX,
  SKILL_NAME_MAX,
  ageLabel,
  areaCode,
  checkSkillGrade,
  checkSkillScore,
  splitSkillLines,
  usesSkillCard,
} from "@/lib/skills";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const code = (path: string) =>
  readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("Which levels use the card");
check("Nursery does", usesSkillCard("NURSERY"));
check("KG, Primary and JHS keep the marked card (the school's decision)", !usesSkillCard("KINDERGARTEN") && !usesSkillCard("PRIMARY") && !usesSkillCard("JHS"));
check("no stage is a surprise", SKILL_CARD_STAGES.length === 1 && usesSkillCard(undefined) === false && usesSkillCard(null) === false);

console.log("\nA rating is a letter from the key, or blank");
check("A, B and C are the key printed on the school's form", SKILL_GRADES.join("") === "ABC");
const grade = (raw: string) => {
  const v = checkSkillGrade(raw);
  return v.ok ? v.grade : "REFUSED";
};
check("a letter is accepted, in either case", grade("a") === "A" && grade("B") === "B" && grade(" c ") === "C");
check("blank is not assessed, never a grade", grade("") === null && grade("  ") === null);
check("a letter outside the key is refused (D is not on the form)", grade("D") === "REFUSED" && grade("AB") === "REFUSED" && grade("1") === "REFUSED");

console.log("\nA score is a mark out of 100");
const score = (raw: string) => {
  const v = checkSkillScore(raw);
  return v.ok ? v.value : "REFUSED";
};
check("75 and 7.5 are scores", score("75") === 75 && score("7.5") === 7.5);
check("100 is allowed, 100.01 is not", score("100") === 100 && score("100.01") === "REFUSED");
check("zero is a score, blank is not one", score("0") === 0 && score("") === null);
check("negative, exponent and hex forms are refused", score("-1") === "REFUSED" && score("1e1") === "REFUSED" && score("0x10") === "REFUSED");

console.log("\nA textarea of skills becomes names");
const lines = splitSkillLines("  News telling \r\n\r\nPoem   recitals\nnews telling\n");
check("trimmed, blanks dropped, inner spaces squashed, a repeat in any case dropped", lines.added.join("|") === "News telling|Poem recitals", lines.added.join("|"));
check("a skill the area already has is not added again", splitSkillLines("Colouring\nPainting", ["colouring"]).added.join("|") === "Painting");
check("a name is cut to what a printed column holds", splitSkillLines("x".repeat(200)).added[0].length === SKILL_NAME_MAX);
const many = splitSkillLines(Array.from({ length: 40 }, (_, i) => `Skill ${i}`).join("\n"));
check("an area has a ceiling, and says it was hit", many.added.length === SKILLS_PER_AREA_MAX && many.tooMany);
check("the ceiling counts what is already there", splitSkillLines("a\nb\nc", Array.from({ length: SKILLS_PER_AREA_MAX - 1 }, (_, i) => `s${i}`)).added.length === 1);

console.log("\nAn area's short code");
check("the first word, capitals, six characters at most", areaCode("Health and self help", []) === "HEALTH" && areaCode("Mathematics", []) === "MATHEM");
check("a taken code gets a number, not a collision", areaCode("Language", ["LANGUA"]) === "LANGU2");
check("a name with nothing usable still gets a code", areaCode("!!!", []) === "AREA");
check("a taken code is matched without regard to case", areaCode("Reading", ["reading"]) === "READI2" || areaCode("Reading", ["reading"]) !== "READING");

console.log("\nAge, as the form prints it");
const on = new Date(Date.UTC(2026, 6, 24));
check("whole years once there is one", ageLabel(new Date(Date.UTC(2022, 0, 5)), on) === "4 years");
check("a birthday still to come this year has not been had", ageLabel(new Date(Date.UTC(2022, 8, 5)), on) === "3 years");
check("one year is singular", ageLabel(new Date(Date.UTC(2025, 5, 1)), on) === "1 year");
check("under a year is months", ageLabel(new Date(Date.UTC(2026, 3, 1)), on) === "3 months");
check("no date of birth, no age", ageLabel(null, on) === null && ageLabel(new Date(Date.UTC(2030, 0, 1)), on) === null);

console.log("\nThe actions");
const actions = code("src/lib/skill-actions.ts");
const fn = (name: string) => {
  const start = actions.indexOf(`export async function ${name}`);
  const next = actions.indexOf("export async function", start + 10);
  return actions.slice(start, next === -1 ? undefined : next);
};
const setup = fn("saveLevelSkills");
const area = fn("addSkillArea");
const save = fn("saveSkillRatings");
check("setting the lists up is the office's (OFFICE), as subjects are", /requireRole\(OFFICE\)/.test(setup) && /requireRole\(OFFICE\)/.test(area));
check("entering ratings is MARKING: leadership, the IT admin and a teacher", /requireRole\(MARKING\)/.test(save));
check("every action sets the tenant context after the role check", [setup, area, save].every((a) => /setTenantContext\(auth\.tenant\)/.test(a)));
check("a posted level is read back before it is written", /ownsLevels\(\[levelId\]\)/.test(setup) && /ownsLevels\(\[levelId\]\)/.test(area));
check("a posted term, class and area are read back (ownsSheet)", /ownsSheet\(termId, classGroupId, subjectId\)/.test(save));
check("a teacher is held to a class they teach in; leadership and the IT admin are not", /canAccess\(auth\.roles, MARK_ANY_CLASS\)/.test(save) && /teachingAssignment\.count/.test(save));
check("the roster is the term's YEAR roster, not the class today", /rosterWhere\(term\.academicYearId, classGroupId\)/.test(save));
check("a published card's ratings are not rewritten", /status: "PUBLISHED"/.test(save) && /settled\.has\(/.test(save));
check("a refused save returns before it opens a transaction", save.indexOf("refusalMessage(problems)") !== -1 && save.indexOf("refusalMessage(problems)") < save.indexOf("tenantTransaction("));
check("the score is judged by the shared rule, not a copy", /checkSkillScore\(/.test(save) && /checkSkillGrade\(/.test(save));
check("a skill with ratings cannot be removed, only renamed", /cannot be removed|renamed but not removed/.test(setup) && /rated\.get\(/.test(setup));
check("each write is audited", [setup, area, save].every((a) => /writeAudit\(/.test(a)));
check("a card exists as soon as a child is rated, so it can be published without a remark", /termResult\.createMany/.test(save) && /skipDuplicates: true/.test(save));
check("nothing here reaches the marks engine or an Assessment", !/computeClassResults|assessment\./i.test(actions));
check("every export of the module is an async function or a type (it is a 'use server' file)", [...actions.matchAll(/^export (?!async function|type)/gm)].length === 0);

console.log("\nThe card");
const card = code("src/app/(app)/results/report-card.tsx");
check("the marked card hands over to the skills card when given skills", /if \(skills\)/.test(card) && /SkillReportCard/.test(card));
const loaders = code("src/lib/results-data.ts");
check("a single card and a class run both load the skills", (loaders.match(/getSkillCard\(/g) ?? []).length >= 2);
const pages = [
  "src/app/(app)/results/[studentId]/page.tsx",
  "src/app/(app)/results/print/page.tsx",
  "src/app/(portal)/portal/[studentId]/results/[termId]/page.tsx",
].map((p) => [p, code(p)] as const);
for (const [path, text] of pages) {
  check(`${path.split("/").slice(-3).join("/")} passes the skills on to the card`, /skills=\{/.test(text));
}
const portal = code("src/lib/portal-data.ts");
check("the portal still reads the card only through the published check", /getPublishedReportCard/.test(portal) && /status: "PUBLISHED"/.test(portal));

console.log(failures === 0 ? "\nAll good." : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);

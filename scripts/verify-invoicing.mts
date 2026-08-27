/**
 * Checks the two decisions that stand between a student and a bill: which fee
 * structure applies to them, and — when none does — what to tell the bursar.
 *
 * Pure functions, no database. Run: npm run verify:invoicing
 */
import {
  chooseFeeStructure,
  explainNoStructure,
  groupSkipped,
  type SkippedStudent,
} from "@/lib/invoice-engine";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) {
    failures += 1;
  }
}

const TERM = "term-1";
const OTHER_TERM = "term-2";

type S = {
  id: string;
  termId: string | null;
  residency: "ANY" | "DAY" | "BOARDING";
  studentType: "ANY" | "NEW" | "CONTINUING";
};
const structure = (id: string, over: Partial<S> = {}): S => ({
  id,
  termId: null,
  residency: "ANY",
  studentType: "ANY",
  ...over,
});

const dayContinuing = { residency: "DAY" as const, isNew: false };
const boardingNew = { residency: "BOARDING" as const, isNew: true };

console.log("Choosing a fee structure");
check(
  "an all-terms, all-students structure applies to anyone",
  chooseFeeStructure([structure("a")], dayContinuing, TERM)?.id === "a",
);
check(
  "a structure for another term does not apply",
  chooseFeeStructure([structure("a", { termId: OTHER_TERM })], dayContinuing, TERM) === null,
);
check(
  "a boarding structure does not apply to a day student",
  chooseFeeStructure([structure("a", { residency: "BOARDING" })], dayContinuing, TERM) === null,
);
check(
  "a new-student structure does not apply to a continuing one",
  chooseFeeStructure([structure("a", { studentType: "NEW" })], dayContinuing, TERM) === null,
);

// Specificity: the most exactly-targeted structure must win, or a school that
// prices boarders separately would bill them the general rate.
check(
  "a term-specific structure beats an all-terms one",
  chooseFeeStructure([structure("all"), structure("this", { termId: TERM })], dayContinuing, TERM)
    ?.id === "this",
);
check(
  "a residency-specific structure beats a general one",
  chooseFeeStructure(
    [structure("any"), structure("boarding", { residency: "BOARDING" })],
    boardingNew,
    TERM,
  )?.id === "boarding",
);
check(
  "term beats residency when both are on offer",
  chooseFeeStructure(
    [structure("boarding", { residency: "BOARDING" }), structure("term", { termId: TERM })],
    boardingNew,
    TERM,
  )?.id === "term",
);
check(
  "the most specific of all wins",
  chooseFeeStructure(
    [
      structure("general"),
      structure("term", { termId: TERM }),
      structure("exact", { termId: TERM, residency: "BOARDING", studentType: "NEW" }),
    ],
    boardingNew,
    TERM,
  )?.id === "exact",
);

console.log("\nExplaining why nobody could be billed");
check(
  "an unpriced level names the level, not the filters",
  explainNoStructure([], dayContinuing, TERM, "Basic 1").kind === "NO_STRUCTURE_FOR_LEVEL",
);
check(
  "a structure for the wrong term is reported as a term problem",
  explainNoStructure([structure("a", { termId: OTHER_TERM })], dayContinuing, TERM, "Basic 1")
    .kind === "WRONG_TERM",
);
check(
  "a boarders-only structure is reported as a residency problem",
  explainNoStructure([structure("a", { residency: "BOARDING" })], dayContinuing, TERM, "Basic 1")
    .kind === "WRONG_RESIDENCY",
);
check(
  "a new-students-only structure is reported as a student-type problem",
  explainNoStructure([structure("a", { studentType: "NEW" })], dayContinuing, TERM, "Basic 1")
    .kind === "WRONG_STUDENT_TYPE",
);

// The order matters: with two things wrong, naming the narrower one sends the
// bursar to fix a detail while the real gap stays.
check(
  "with both the term and the residency wrong, the term is named first",
  explainNoStructure(
    [structure("a", { termId: OTHER_TERM, residency: "BOARDING" })],
    dayContinuing,
    TERM,
    "Basic 1",
  ).kind === "WRONG_TERM",
);

const residencyReason = explainNoStructure(
  [structure("a", { residency: "BOARDING" })],
  dayContinuing,
  TERM,
  "Basic 1",
);
check(
  "the residency named is the student's, not the structure's",
  residencyReason.kind === "WRONG_RESIDENCY" && residencyReason.residency === "DAY",
  residencyReason.kind === "WRONG_RESIDENCY" ? residencyReason.residency : residencyReason.kind,
);

console.log("\nGrouping the skipped students");
const skipped: SkippedStudent[] = [
  { admissionNo: "ADM/0001", name: "Kuukua Esaawa", reason: { kind: "NO_CLASS" } },
  { admissionNo: "ADM/0002", name: "Kpetigo Seyram", reason: { kind: "NO_CLASS" } },
  {
    admissionNo: "ADM/0003",
    name: "Ama Serwaa",
    reason: { kind: "NO_STRUCTURE_FOR_LEVEL", level: "JHS 2" },
  },
  {
    admissionNo: "ADM/0004",
    name: "Kofi Mensah",
    reason: { kind: "NO_STRUCTURE_FOR_LEVEL", level: "Basic 1" },
  },
];

const groups = groupSkipped(skipped);
check("one group per distinct problem", groups.length === 3, `${groups.length} groups`);
check(
  "two levels missing a structure stay separate, because they are two fixes",
  groups.filter((g) => g.problem.includes("no fee structure")).length === 2,
);
check(
  "the biggest group is listed first",
  groups[0].students.length === 2 && groups[0].problem.includes("not in a class"),
  groups[0].problem,
);
check(
  "every group says what to do, naming a screen",
  groups.every((g) => g.fix.length > 0 && /Students|Fee structure/.test(g.fix)),
);
check(
  "the unpriced level is named in the fix, not just the problem",
  groups.some((g) => g.fix.includes("JHS 2")),
  groups.find((g) => g.problem.includes("JHS 2"))?.fix,
);
check(
  "no student is lost in the grouping",
  groups.reduce((sum, g) => sum + g.students.length, 0) === skipped.length,
);
check(
  "a single student reads as singular",
  groupSkipped([skipped[2]])[0].problem.startsWith("JHS 2"),
  groupSkipped([skipped[2]])[0].problem,
);
check("nothing skipped means nothing to report", groupSkipped([]).length === 0);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);

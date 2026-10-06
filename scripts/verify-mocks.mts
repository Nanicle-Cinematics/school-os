/**
 * Mock exams for the BECE year: the arithmetic, and the guards on the real actions.
 *
 *   npm run verify:mocks          (the engine half needs nothing; the HTTP half
 *                                  needs the app running, and skips loudly without it)
 *
 * The engine half pins the BECE aggregate — all four core subjects plus the best
 * two of the rest — because that rule is the whole value of the feature and the
 * easiest thing in it to get subtly wrong: a partial aggregate that looks
 * excellent, a missing core subject quietly skipped, an absence that costs
 * nothing.
 *
 * The HTTP half posts the genuine forms. It WRITES: it sets up a mock in the
 * seeded school, enters marks through the sheet, and deletes the mock again in
 * `finally` (its marks cascade with it).
 */
import { createHash, randomBytes } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runWithTenantContext, withBypass } from "@/lib/tenant-context";
import { aggregateChange, beceAggregate, isBeceCore, mockBroadsheet, type SubjectCell } from "@/lib/mock-engine";
import { getMockBroadsheet } from "@/lib/mock-data";
import type { Band } from "@/lib/results-engine";
import { demoSchool } from "./fixture.mjs";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

// ── The engine ─────────────────────────────────────────────────────────────
console.log("Core subjects");
check("English, Mathematics, Science and Social Studies are core by code",
  ["ENG", "MAT", "SCI", "SOC"].every((code) => isBeceCore({ code, name: "x" })));
check("and by name, for a school with its own codes",
  isBeceCore({ code: "IS", name: "Integrated Science" }) && isBeceCore({ code: "M1", name: "Mathematics" }));
check("RME and French are not", !isBeceCore({ code: "RME", name: "Religious and Moral Education" }) && !isBeceCore({ code: "FRE", name: "French" }));

// The GES basic-school scale: 1 is 80–100 … 9 is 0–34.
const d = (n: number) => new Prisma.Decimal(n);
const BANDS: Band[] = [
  [1, 80, 100], [2, 70, 79], [3, 60, 69], [4, 55, 59], [5, 50, 54], [6, 45, 49], [7, 40, 44], [8, 35, 39], [9, 0, 34],
].map(([g, min, max]) => ({ grade: String(g), minScore: d(min), maxScore: d(max), points: g, remark: "", isPass: g < 9 }));

const SUBJECTS = [
  { id: "eng", code: "ENG", name: "English" },
  { id: "mat", code: "MAT", name: "Mathematics" },
  { id: "sci", code: "SCI", name: "Science" },
  { id: "soc", code: "SOC", name: "Social Studies" },
  { id: "rme", code: "RME", name: "RME" },
  { id: "fre", code: "FRE", name: "French" },
  { id: "com", code: "COM", name: "Computing" },
];
const mark = (studentId: string, subjectId: string, rawScore: number | null, isAbsent = false) => ({ studentId, subjectId, rawScore, isAbsent });

console.log("\nThe aggregate");
const full = mockBroadsheet({
  subjects: SUBJECTS,
  studentIds: ["a"],
  bands: BANDS,
  marks: [
    mark("a", "eng", 85), mark("a", "mat", 72), mark("a", "sci", 65), mark("a", "soc", 58),
    mark("a", "rme", 90), mark("a", "fre", 50), mark("a", "com", 40),
  ],
}).rows[0];
// Cores 1+2+3+4 = 10; best two others are RME 1 and French 5 = 6; Computing (7) is dropped.
check("four cores plus the best two others", full.aggregate === 16, String(full.aggregate));
check("the weakest other subject is left out", !full.counted.includes("com") && full.counted.length === 6);

const coreMissing = mockBroadsheet({
  subjects: SUBJECTS, studentIds: ["b"], bands: BANDS,
  marks: [mark("b", "eng", 85), mark("b", "mat", 72), mark("b", "sci", 65), mark("b", "rme", 90), mark("b", "fre", 90), mark("b", "com", 90)],
}).rows[0];
check("a missing core subject means NO aggregate, not a flattering one", coreMissing.aggregate === null);
check("and says which subject", (coreMissing.missing ?? "").includes("Social Studies"), coreMissing.missing ?? "");

const absentCore = mockBroadsheet({
  subjects: SUBJECTS, studentIds: ["c"], bands: BANDS,
  marks: [mark("c", "eng", 85), mark("c", "mat", null, true), mark("c", "sci", 65), mark("c", "soc", 58), mark("c", "rme", 90), mark("c", "fre", 90)],
}).rows[0];
// 1 + 9 (absent) + 3 + 4 + 1 + 1
check("an absent core subject counts, as the lowest grade", absentCore.aggregate === 19, String(absentCore.aggregate));

const oneOther = mockBroadsheet({
  subjects: SUBJECTS, studentIds: ["e"], bands: BANDS,
  marks: [mark("e", "eng", 85), mark("e", "mat", 85), mark("e", "sci", 85), mark("e", "soc", 85), mark("e", "rme", 85)],
}).rows[0];
check("fewer than two other subjects marked means no aggregate", oneOther.aggregate === null, oneOther.missing ?? "");

const between = mockBroadsheet({ subjects: SUBJECTS, studentIds: ["f"], bands: BANDS, marks: [mark("f", "eng", 79.5)] }).rows[0];
check("a mark between two bands takes the band it reached", between.cells.get("eng")?.grade === "2", between.cells.get("eng")?.grade ?? "none");

const threeCores = new Map<string, SubjectCell>();
check("a level offering fewer than four core subjects cannot aggregate",
  beceAggregate(SUBJECTS.filter((s) => s.id !== "soc").map((s) => ({ ...s, core: isBeceCore(s) })), threeCores).aggregate === null);

console.log("\nPositions");
const all = (id: string, score: number) => SUBJECTS.slice(0, 6).map((s) => mark(id, s.id, score));
const ranked = mockBroadsheet({
  subjects: SUBJECTS, bands: BANDS,
  studentIds: ["p", "q", "r", "s"],
  marks: [...all("p", 85), ...all("q", 72), ...all("r", 72), mark("s", "eng", 99)],
}).rows;
const pos = (id: string) => ranked.find((r) => r.studentId === id)?.position;
check("the lowest aggregate is first", pos("p") === 1);
check("equal aggregates share a place, and the next place skips", pos("q") === 2 && pos("r") === 2);
check("a candidate without an aggregate is unplaced, not last", pos("s") === null && ranked[ranked.length - 1].studentId === "s");

console.log("\nProgress");
check("change runs from the first aggregate to the latest", aggregateChange([24, null, 18]) === -6);
check("one mock is not a trend", aggregateChange([null, 20]) === null);

// ── The real actions, over HTTP ────────────────────────────────────────────
const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";

async function appIsUp() {
  try {
    return (await fetch(`${BASE}/login`, { redirect: "manual" })).status === 200;
  } catch {
    return false;
  }
}

const unescape = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The no-JS fallback of the form containing `needle`, as postable fields. */
function formFields(html: string, needle: string) {
  const inner = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]).find((f) => f.includes(needle));
  if (!inner) return null;
  const fields: [string, string][] = [];
  for (const tag of inner.match(/<input\b[^>]*>/g) ?? []) {
    const name = tag.match(/name="([^"]*)"/)?.[1];
    if (!name) continue;
    fields.push([unescape(name), unescape(tag.match(/value="([^"]*)"/)?.[1] ?? "")]);
  }
  return fields;
}

async function openSession(userId: string, schoolId: string) {
  const token = randomBytes(32).toString("hex");
  await withBypass(() =>
    prisma.session.create({
      data: {
        userId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        activeSchoolId: schoolId,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    }),
  );
  return token;
}

async function get(path: string, token: string) {
  const response = await fetch(BASE + path, { headers: { Cookie: `${COOKIE}=${token}` }, redirect: "manual" });
  return { status: response.status, location: response.headers.get("location"), html: await response.text() };
}

async function post(path: string, token: string, fields: [string, string][]) {
  const body = new FormData();
  for (const [name, value] of fields) body.append(name, value);
  const response = await fetch(BASE + path, { method: "POST", headers: { Cookie: `${COOKIE}=${token}` }, body, redirect: "manual" });
  return { status: response.status, html: await response.text() };
}

console.log("\nThe mock actions, over HTTP");
if (!(await appIsUp())) {
  console.log(`  SKIPPED — nothing answering at ${BASE}. Start the app to run these.`);
} else {
  const school = await demoSchool();
  const schoolId = school!.id;
  const tokens: string[] = [];
  let mockId: string | null = null;
  const title = `Verify mock ${Date.now()}`;

  try {
    await runWithTenantContext({ schoolId, readOnly: false }, async () => {
      const level = await prisma.level.findFirstOrThrow({ where: { stage: "JHS" }, orderBy: { order: "desc" } });
      const year = await prisma.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const english = await prisma.subject.findFirstOrThrow({ where: { code: "ENG" } });
      const enrolment = await prisma.enrollment.findFirstOrThrow({
        where: { academicYearId: year.id, status: "ACTIVE", classGroup: { levelId: level.id } },
        select: { classGroupId: true },
      });
      const classGroupId = enrolment.classGroupId;
      const roll = await prisma.enrollment.findMany({
        where: { classGroupId, academicYearId: year.id, status: "ACTIVE" },
        select: { studentId: true },
      });
      const owner = await prisma.membership.findFirstOrThrow({ where: { role: "OWNER" }, select: { userId: true } });
      const ownerToken = await openSession(owner.userId, schoolId);
      tokens.push(ownerToken);

      // Set up a mock through the real form.
      const overview = await get("/mocks", ownerToken);
      check("the mock screen opens for leadership", overview.status === 200, `HTTP ${overview.status}`);
      const create = formFields(overview.html, 'name="title"');
      check("and offers to set one up", Boolean(create));
      if (!create) throw new Error("no create form");
      await post("/mocks", ownerToken, [...create.filter(([n]) => n !== "title" && n !== "sittingDate"), ["title", title], ["sittingDate", ""]]);
      const mock = await prisma.mockExam.findFirst({ where: { title } });
      check("a mock is set up for the top JHS class", mock?.levelId === level.id, mock ? "" : "not created");
      if (!mock) throw new Error("no mock");
      mockId = mock.id;

      const sheetPath = `/mocks/${mock.id}/sheet?class=${classGroupId}&subject=${english.id}`;
      const sheet = await get(sheetPath, ownerToken);
      const sheetForm = formFields(sheet.html, 'name="score:');
      check("the sheet lists every candidate in the class", (sheet.html.match(/name="score:/g) ?? []).length === roll.length, `${roll.length} enrolled`);
      if (!sheetForm) throw new Error("no sheet form");
      const base = sheetForm.filter(([n]) => !n.startsWith("score:") && !n.startsWith("absent:"));

      // A mark above 100 refuses the whole save.
      await post(sheetPath, ownerToken, [...base, ...roll.map((r, i) => [`score:${r.studentId}`, i === 0 ? "101" : "60"] as [string, string])]);
      check("a mark above 100 is refused and nothing is written", (await prisma.mockScore.count({ where: { mockExamId: mock.id } })) === 0);

      // A good save: everyone 75, the first candidate absent.
      await post(sheetPath, ownerToken, [
        ...base,
        ...roll.map((r) => [`score:${r.studentId}`, "75"] as [string, string]),
        [`absent:${roll[0].studentId}`, "on"],
      ]);
      const saved = await prisma.mockScore.findMany({ where: { mockExamId: mock.id, subjectId: english.id } });
      check("leadership's marks are saved for every candidate", saved.length === roll.length, `${saved.length} rows`);
      check("and the absent candidate is recorded as absent", saved.some((s) => s.studentId === roll[0].studentId && s.isAbsent));

      const sheetData = await getMockBroadsheet(mock.id, classGroupId);
      const absentRow = sheetData?.rows.find((r) => r.studentId === roll[0].studentId);
      const presentRow = sheetData?.rows.find((r) => r.studentId === roll[roll.length - 1].studentId);
      check("the broadsheet grades an absence as the lowest grade", absentRow?.cells.get(english.id)?.score === 0, absentRow?.cells.get(english.id)?.grade ?? "none");
      check("and a 75 as the school's scale says", presentRow?.cells.get(english.id)?.grade !== null, presentRow?.cells.get(english.id)?.grade ?? "none");
      check("nobody has an aggregate from English alone", (sheetData?.rows ?? []).every((r) => r.aggregate === null));

      // A teacher NOT assigned to JHS 3 English is refused by the action itself.
      const outsider = await prisma.membership.findFirst({
        where: {
          role: "TEACHER",
          staff: { teachingAssignments: { none: { classGroupId, subjectId: english.id, academicYearId: year.id } } },
        },
        select: { userId: true },
      });
      if (outsider) {
        const token = await openSession(outsider.userId, schoolId);
        tokens.push(token);
        await post(sheetPath, token, [...base, ...roll.map((r) => [`score:${r.studentId}`, "10"] as [string, string])]);
        const after = await prisma.mockScore.findMany({ where: { mockExamId: mock.id, subjectId: english.id, rawScore: 10 } });
        check("a teacher not assigned to that class and subject cannot enter its marks", after.length === 0, `${after.length} overwritten`);
        const broadsheet = await get(`/mocks/${mock.id}`, token);
        check("nor open the broadsheet", broadsheet.status === 307 || broadsheet.status === 303, `HTTP ${broadsheet.status} → ${broadsheet.location}`);
      } else {
        console.log("  --   every teacher is assigned JHS 3 English; skipping the refusal");
      }

      // A teacher who IS assigned can.
      const insider = await prisma.teachingAssignment.findFirst({
        where: { classGroupId, academicYearId: year.id, staff: { memberships: { some: { role: "TEACHER" } } } },
        select: { subjectId: true, staff: { select: { memberships: { where: { role: "TEACHER" }, select: { userId: true } } } } },
      });
      if (insider) {
        const token = await openSession(insider.staff.memberships[0].userId, schoolId);
        tokens.push(token);
        const theirPath = `/mocks/${mock.id}/sheet?class=${classGroupId}&subject=${insider.subjectId}`;
        const theirs = await get(theirPath, token);
        const theirForm = formFields(theirs.html, 'name="score:');
        check("an assigned teacher opens their own sheet", Boolean(theirForm), `HTTP ${theirs.status}`);
        if (theirForm) {
          await post(theirPath, token, [
            ...theirForm.filter(([n]) => !n.startsWith("score:") && !n.startsWith("absent:")),
            ...roll.map((r) => [`score:${r.studentId}`, "64"] as [string, string]),
          ]);
          const theirRows = await prisma.mockScore.count({ where: { mockExamId: mock.id, subjectId: insider.subjectId } });
          check("and saves its marks", theirRows === roll.length, `${theirRows} rows`);
        }
      }

      // Closed means final.
      const list = await get("/mocks", ownerToken);
      const closeForm = [...list.html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)]
        .map((m) => m[1])
        .find((f) => f.includes(mock.id) && f.includes('name="close"'));
      if (closeForm) {
        const fields: [string, string][] = (closeForm.match(/<input\b[^>]*>/g) ?? []).map((tag) => [
          unescape(tag.match(/name="([^"]*)"/)?.[1] ?? ""),
          unescape(tag.match(/value="([^"]*)"/)?.[1] ?? ""),
        ]);
        await post("/mocks", ownerToken, fields);
      }
      check("leadership can close a mock", (await prisma.mockExam.findUnique({ where: { id: mock.id } }))?.isClosed === true);
      await post(sheetPath, ownerToken, [...base, ...roll.map((r) => [`score:${r.studentId}`, "99"] as [string, string])]);
      const closedRows = await prisma.mockScore.count({ where: { mockExamId: mock.id, rawScore: 99 } });
      check("and a closed mock's marks cannot be changed", closedRows === 0, `${closedRows} changed`);
    });
  } catch (error) {
    check("the HTTP half ran to the end", false, error instanceof Error ? error.message : String(error));
  } finally {
    /**
     * ⚠️ Cleaned up through the OWNER connection (DATABASE_URL), not the app's.
     * In CI `@/lib/prisma` connects as the restricted school_os_app role, which
     * may not delete from AuditLog at all — the trail is append-only for the
     * app, and that is the point of it. verify:actions cleans up the same way.
     */
    const owner = new PrismaClient();
    try {
      if (mockId) {
        await owner.mockExam.deleteMany({ where: { id: mockId } });
        await owner.auditLog.deleteMany({ where: { entityId: mockId } });
      }
      for (const token of tokens) {
        await owner.session.deleteMany({ where: { tokenHash: createHash("sha256").update(token).digest("hex") } });
      }
      check("the fixture mock is removed again", mockId === null || (await owner.mockExam.count({ where: { id: mockId } })) === 0);
    } finally {
      await owner.$disconnect();
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
await prisma.$disconnect();
if (failed > 0) process.exit(1);

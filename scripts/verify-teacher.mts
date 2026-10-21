/**
 * Prove a class teacher can reach the report-card entry screens and their own
 * class register, and nothing else.
 *
 * The point is not that the nav hides the other links — a hidden link is not a
 * guard. This signs in as a teacher and asks for every route in the app by URL,
 * the way someone pasting a bookmark would, and asserts each one either serves
 * the marking screens or redirects away.
 *
 *   npm run dev
 *   npm run verify:teacher
 *
 * The second half checks that a teaching assignment only counts for its own
 * academic year. That needs fixtures the demo cannot supply — every seeded
 * teacher already teaches in every class — so it creates one staff member, one
 * login and one past academic year, and deletes all three at the end.
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { demoSchool } from "./fixture.mjs";
import { landingFor, isTeacherOnly } from "@/lib/permissions";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";
const LANDING = "/assessments/sheet";

/**
 * The screens a teacher signs in to use: marking, remarks, their register — and
 * the daily attendance register, which is the one place a plain teacher WRITES
 * about a class. The class page itself stays read-only for them. And the mock
 * exams list, from which a JHS 3 subject teacher enters mock marks; the mock
 * broadsheet and progress behind it are leadership's.
 */
const ALLOWED = ["/assessments/sheet", "/results/remarks", "/results/skills", "/classes", "/attendance", "/mocks"];

/** Everything else reachable from the sidebar or by typing a URL. */
const FORBIDDEN = [
  "/dashboard",
  "/students",
  "/students/import",
  "/guardians",
  "/staff",
  "/houses",
  "/subjects",
  "/subjects/skills",
  "/assessments",
  "/results",
  "/results/broadsheet",
  "/mocks/progress",
  "/promotions",
  "/fees",
  "/invoices",
  "/payments",
  "/expenses",
  "/messages",
  "/users",
  "/settings",
  "/settings/structure",
  "/settings/terms",
  "/settings/grading",
  "/settings/components",
  "/admin",
];

let passed = 0;
let failed = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function get(path: string, cookie: string, tries = 8) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(BASE + path, {
        headers: { Cookie: `${COOKIE}=${cookie}` },
        redirect: "manual",
      });
      if (r.status === 500) {
        await sleep(500 * (i + 1));
        continue;
      }
      return { status: r.status, location: r.headers.get("location"), html: await r.text() };
    } catch {
      await sleep(500 * (i + 1));
    }
  }
  throw new Error(`GET ${path} never answered`);
}

/** The sidebar's links, which is what the teacher can actually see. */
function navLinks(html: string) {
  const nav = html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
  return [...nav.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

async function main() {
  const membership = await withBypass(() =>
    prisma.membership.findFirst({
      where: { role: "TEACHER", status: "ACTIVE" },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
  );
  if (!membership) throw new Error("no teacher membership in this database");

  const roles = await withBypass(() =>
    prisma.membership.findMany({
      where: { userId: membership.userId, schoolId: membership.schoolId },
      select: { role: true },
    }),
  );
  const roleList = roles.map((r) => r.role);
  check("the fixture is a teacher and nothing else", isTeacherOnly(roleList), roleList.join(", "));
  check("their landing is the mark sheet", landingFor(roleList) === LANDING, landingFor(roleList));

  const token = randomBytes(32).toString("hex");
  await withBypass(() =>
    prisma.session.create({
      data: {
        userId: membership.userId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        activeSchoolId: membership.schoolId,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    }),
  );

  console.log(`\nSigned in as ${membership.user.name} <${membership.user.email}>\n`);

  for (const path of ALLOWED) {
    const r = await get(path, token);
    check(`${path} opens`, r.status === 200, `status ${r.status}`);
  }

  console.log("");
  for (const path of FORBIDDEN) {
    const r = await get(path, token);
    // A redirect anywhere off the page counts; what must not happen is a 200
    // rendering the screen itself.
    const redirected = r.status >= 300 && r.status < 400;
    check(
      `${path} is refused`,
      redirected,
      redirected ? `-> ${r.location}` : `status ${r.status} — RENDERED`,
    );
  }

  console.log("");
  const sheet = await get(LANDING, token);
  const links = navLinks(sheet.html);
  const extra = links.filter((href) => !ALLOWED.includes(href));
  check("the sidebar offers only the marking screens and the register", extra.length === 0,
    extra.length ? `also offers ${extra.join(", ")}` : links.join(", "));

  await withBypass(() =>
    prisma.session.deleteMany({
      where: { tokenHash: createHash("sha256").update(token).digest("hex") },
    }),
  );

  await yearScoping();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * An assignment belongs to an academic year, and must not grant marking rights
 * in any other. This used to be wrong in three places at once — the sheet
 * pickers, the save guard and the report card's teacher name all queried
 * `teachingAssignment` with no year filter — so a teacher kept last year's
 * classes invisibly, since /staff/[id] only ever lists the current year.
 */
async function yearScoping() {
  console.log("");
  /**
   * ⚠️ ONE school, and everything else scoped to it.
   *
   * This used to be `school.findFirst()` with the year, the term and the class
   * each found by their own unscoped `findFirst` — so on a machine with more
   * than one school it built a fixture out of PARTS OF DIFFERENT SCHOOLS: a
   * teacher in school A marking school B's class in school B's term. The sheet
   * then correctly had nothing to show, and the failure read "0 score inputs",
   * which names neither the cause nor the school. See `demoSchool`.
   */
  const school = await demoSchool();
  const year = await withBypass(() =>
    prisma.academicYear.findFirst({ where: { schoolId: school.id, isCurrent: true } }),
  );
  const term = await withBypass(() =>
    prisma.term.findFirst({ where: { schoolId: school.id, isCurrent: true } }),
  );
  if (!year || !term) {
    console.log(`  --   ${school.slug} has no current year or term — cannot check year scoping`);
    return;
  }

  const stamp = Date.now().toString(36);
  const staff = await withBypass(() =>
    prisma.staff.create({
      data: {
        schoolId: school.id,
        staffNo: `QA-${stamp}`,
        firstName: "QA",
        lastName: "Marker",
        gender: "FEMALE",
        isTeaching: true,
      },
    }),
  );
  const user = await withBypass(() =>
    prisma.user.create({
      data: {
        name: "QA Marker",
        email: `qa-marker-${stamp}@example.com`,
        passwordHash: randomBytes(32).toString("hex"),
        schoolId: school.id,
      },
    }),
  );
  const membership = await withBypass(() =>
    prisma.membership.create({
      data: {
        schoolId: school.id,
        userId: user.id,
        staffId: staff.id,
        role: "TEACHER",
        status: "ACTIVE",
        invitedAt: new Date(),
        acceptedAt: new Date(),
      },
    }),
  );
  const priorYear = await withBypass(() =>
    prisma.academicYear.create({
      data: {
        schoolId: school.id,
        name: `QA Prior Year ${stamp}`,
        startDate: new Date("2000-09-01"),
        endDate: new Date("2001-07-31"),
        isCurrent: false,
      },
    }),
  );

  /**
   * A class the sheet can actually show: one with an OPEN sheet this term.
   *
   * The old version took any class and any subject its level offers, then
   * asserted score inputs appeared. A mark sheet has inputs only once its
   * components exist — a class nobody has opened a sheet for renders "this
   * sheet has not been opened yet", which is the product working. So the
   * fixture now starts from a pair that HAS components, and the assertion is
   * about year scoping rather than about which class the seed happened to
   * prepare.
   */
  const opened = await withBypass(() =>
    prisma.assessment.findFirst({
      where: { schoolId: school.id, termId: term.id },
      select: { classGroupId: true, subjectId: true },
      orderBy: { createdAt: "asc" },
    }),
  );
  if (!opened) {
    check(
      "the seed has at least one open mark sheet to scope-check",
      false,
      `no assessment in ${school.slug}'s current term — re-seed, or the sheet checks below are meaningless`,
    );
    return;
  }
  const classGroup = await withBypass(() =>
    prisma.classGroup.findUnique({ where: { id: opened.classGroupId } }),
  );
  const offering = { subjectId: opened.subjectId };

  const assignment = await withBypass(() =>
    prisma.teachingAssignment.create({
      data: {
        schoolId: school.id,
        academicYearId: priorYear.id,
        staffId: staff.id,
        classGroupId: classGroup!.id,
        subjectId: offering!.subjectId,
      },
    }),
  );

  const token = randomBytes(32).toString("hex");
  await withBypass(() =>
    prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        activeSchoolId: school.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    }),
  );

  const url = `/assessments/sheet?term=${term.id}&class=${classGroup!.id}&subject=${offering!.subjectId}`;
  const scores = (html: string) => (html.match(/name="score:/g) ?? []).length;
  const classPicker = (html: string) =>
    html.match(/<select name="class"[\s\S]*?<\/select>/)?.[0] ?? "";

  const stale = await get(url, token);
  check("a previous year's assignment opens no sheet this year", scores(stale.html) === 0,
    `${scores(stale.html)} score inputs`);
  check("nor does that class appear in the picker",
    !classPicker(stale.html).includes(classGroup!.id));

  // The register follows the same year rule, and a pasted URL is refused, not
  // merely unlinked.
  const staleRegister = await get(`/classes/${classGroup!.id}`, token);
  check("nor does that class's register open",
    staleRegister.status >= 300 && staleRegister.status < 400,
    `status ${staleRegister.status}`);
  const staleList = await get("/classes", token);
  check("and /classes lists no classes for them",
    staleList.status === 200 && !staleList.html.includes(`/classes/${classGroup!.id}`));

  await withBypass(() =>
    prisma.teachingAssignment.update({
      where: { id: assignment.id },
      data: { academicYearId: year.id },
    }),
  );

  const current = await get(url, token);
  check("the same assignment in the current year does open it", scores(current.html) > 0,
    `${scores(current.html)} score inputs`);
  check("and that class appears in the picker",
    classPicker(current.html).includes(classGroup!.id));

  const register = await get(`/classes/${classGroup!.id}?view=register`, token);
  check("and its register opens, boys then girls", register.status === 200 &&
    register.html.includes("Boys (") && register.html.includes("Girls ("),
    `status ${register.status}`);
  // Read-only: none of the office's forms may render for a teacher.
  const forms = ["Save changes", "Save assignments", "Delete class"].filter((label) =>
    register.html.includes(label));
  check("the register is read-only for a teacher", forms.length === 0,
    forms.length ? `renders ${forms.join(", ")}` : "no edit, assignment or delete form");
  const currentList = await get("/classes", token);
  check("and /classes lists that class and only theirs",
    currentList.html.includes(`/classes/${classGroup!.id}`) &&
      (currentList.html.match(/href="\/classes\/[a-z0-9]+"/g) ?? []).length === 1,
    `${(currentList.html.match(/href="\/classes\/[a-z0-9]+"/g) ?? []).length} class links`);

  /**
   * The attendance register is the FORM teacher's alone (mayMark in
   * attendance-actions.ts). A subject assignment opens the mark sheet above,
   * but must not open the register: the school asked that the Basic 1 teacher
   * mark Basic 1 and nothing else.
   */
  const registerOptions = (html: string) =>
    (html.match(/<select name="class"[\s\S]*?<\/select>/)?.[0] ?? "").match(/<option value="[^"]+"/g) ?? [];
  const assignedOnly = await get("/attendance", token);
  check("a subject assignment alone does not offer that class's attendance register",
    !registerOptions(assignedOnly.html).some((option) => option.includes(classGroup!.id)),
    `${registerOptions(assignedOnly.html).length} classes offered`);

  const originalFormTeacher = classGroup!.formTeacherId;
  const otherClass = await withBypass(() =>
    prisma.classGroup.findFirst({ where: { schoolId: school.id, id: { not: classGroup!.id } }, select: { id: true } }),
  );
  await withBypass(() =>
    prisma.classGroup.update({ where: { id: classGroup!.id }, data: { formTeacherId: staff.id } }),
  );
  try {
    const day = term.startDate.toISOString().slice(0, 10);
    const own = await get(`/attendance?class=${classGroup!.id}&date=${day}`, token);
    const offered = registerOptions(own.html);
    check("the form teacher is offered their own class's register, and only it",
      offered.length === 1 && offered[0].includes(classGroup!.id), `${offered.length} classes offered`);

    // A forged post for another class IN WHICH THIS TEACHER TEACHES A SUBJECT
    // is refused by the action itself, not merely left out of the picker.
    // That is the case the old rule allowed; a class they have nothing to do
    // with was refused before as well, and would prove nothing.
    const unescape = (value: string) =>
      value.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const registerForm = [...own.html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)]
      .map((match) => match[1])
      .find((inner) => inner.includes('name="mark:'));
    check("their register renders a form to mark", Boolean(registerForm));
    if (registerForm && otherClass) {
      const otherAssignment = await withBypass(() =>
        prisma.teachingAssignment.create({
          data: {
            schoolId: school.id,
            academicYearId: year.id,
            staffId: staff.id,
            classGroupId: otherClass.id,
            subjectId: offering!.subjectId,
          },
        }),
      );
      const before = await withBypass(() =>
        prisma.attendanceDay.findMany({ where: { classGroupId: otherClass.id }, select: { id: true } }),
      );
      // The other class's own pupils, all present: a register the action would
      // accept from anyone allowed to take it.
      const otherRoll = await withBypass(() =>
        prisma.enrollment.findMany({
          where: { classGroupId: otherClass.id, academicYearId: year.id, status: "ACTIVE" },
          select: { studentId: true },
        }),
      );
      const body = new FormData();
      for (const tag of registerForm.match(/<input\b[^>]*>/g) ?? []) {
        const name = tag.match(/name="([^"]*)"/)?.[1];
        if (!name || name.startsWith("mark:") || name.startsWith("note:")) continue;
        const value = unescape(tag.match(/value="([^"]*)"/)?.[1] ?? "");
        body.append(unescape(name), name === "classGroupId" ? otherClass.id : value);
      }
      for (const row of otherRoll) body.append(`mark:${row.studentId}`, "PRESENT");
      const posted = await fetch(`${BASE}/attendance?class=${classGroup!.id}&date=${day}`, {
        method: "POST",
        headers: { Cookie: `${COOKIE}=${token}` },
        body,
        redirect: "manual",
      });
      const reply = await posted.text();
      const after = await withBypass(() =>
        prisma.attendanceDay.findMany({ where: { classGroupId: otherClass.id }, select: { id: true } }),
      );
      const written = after.filter((day) => !before.some((old) => old.id === day.id)).map((day) => day.id);
      check("a register posted for a class they only teach a subject in is refused",
        /Only the class/.test(reply) && written.length === 0,
        `HTTP ${posted.status}, ${written.length} registers written`);
      await withBypass(async () => {
        if (written.length) {
          await prisma.attendanceEntry.deleteMany({ where: { attendanceDayId: { in: written } } });
          await prisma.attendanceDay.deleteMany({ where: { id: { in: written } } });
        }
        await prisma.teachingAssignment.delete({ where: { id: otherAssignment.id } });
      });
    }
  } finally {
    await withBypass(() =>
      prisma.classGroup.update({ where: { id: classGroup!.id }, data: { formTeacherId: originalFormTeacher } }),
    );
  }

  await withBypass(async () => {
    await prisma.session.deleteMany({
      where: { tokenHash: createHash("sha256").update(token).digest("hex") },
    });
    await prisma.teachingAssignment.delete({ where: { id: assignment.id } });
    await prisma.academicYear.delete({ where: { id: priorYear.id } });
    await prisma.membership.delete({ where: { id: membership.id } });
    await prisma.staff.delete({ where: { id: staff.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
}

main()
  .catch((e) => {
    console.error("FATAL", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * Exercise the real server actions over HTTP and assert that the guards refuse.
 *
 * Why this exists: every other verify-* script calls engine code directly, which
 * cannot reach a server action — the guards that stop a bursar deleting a billed
 * student, or an overlapping grade band silently rewriting a report card, live in
 * `"use server"` functions behind `requireRole`. This drives them the way a
 * browser with JavaScript disabled would: Next renders each form with a real
 * `method="POST"` fallback whose hidden inputs carry the action id, so replaying
 * that POST runs the genuine action, validation and transaction included.
 *
 * SAFETY: every assertion here is a REFUSAL or a preview. Nothing in this file
 * is expected to write, which is what makes it safe to run against the seeded
 * database as often as you like. The one exception is `foreignIdGuards`, which
 * builds a throw-away second school to point ids at and deletes it again, and
 * puts back the two ledger mappings its controls change. If you add a case, keep that property — a
 * verification script that mutates is a liability, not a test.
 *
 *   npm run dev            # in another terminal
 *   npm run verify:actions
 *
 * Against a deployed environment, where there is no local database and possibly
 * no data yet, sign in through the real login form instead:
 *
 *   VERIFY_BASE_URL=https://www.schoolosafrica.com \
 *   VERIFY_EMAIL=you@example.com VERIFY_PASSWORD='…' npm run verify:actions
 *
 * The guard checks need fixtures (a graded scale, a billed student, a level in
 * use); where those are absent the suite says so and skips rather than passing
 * vacuously. The deployment checks below run everywhere and are the ones worth
 * having after a deploy.
 */

import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE_NAME = "school_os_session";
const EMAIL = process.env.VERIFY_EMAIL;
const PASSWORD = process.env.VERIFY_PASSWORD;

// Signing in through the form needs no database at all, which is what makes
// this usable against a deployment whose database you cannot reach.
const usingForm = Boolean(EMAIL && PASSWORD);
const prisma = usingForm ? null : new PrismaClient();
let hasDb = !usingForm;

let passed = 0;
let failed = 0;

function ok(label, detail = "") {
  passed += 1;
  console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
}

function bad(label, detail) {
  failed += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
}

function check(label, condition, detail) {
  if (condition) ok(label, detail);
  else bad(label, detail);
}

/**
 * The script's own database reads need the same patience as its HTTP calls:
 * this connection is as pooled and as droppable as the app's, and a P2024 here
 * is noise, not a verdict.
 */
async function db(operation, tries = 8) {
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      await sleep(400 * (attempt + 1));
    }
  }
  throw last;
}

// ── HTTP, with patience ─────────────────────────────────────────────────────
// The pooled connection drops often enough that a 500 is usually noise rather
// than a result; retry before believing it. Retries back off — hammering a
// stalled pool eight times in a second only reproduces the same stall.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPage(path, cookie, tries = 10) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(BASE + path, {
        headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
        redirect: "manual",
      });
      if (response.status === 500) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      return { status: response.status, html: await response.text() };
    } catch {
      await sleep(400 * (attempt + 1));
    }
  }
  throw new Error(`GET ${path} never succeeded`);
}

async function postForm(path, form, overrides, cookie, tries = 8) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const body = new FormData();
    const used = new Set();
    for (const field of form.fields) {
      if (field.type === "checkbox" && !field.checked && !(field.name in overrides)) continue;
      if (field.name in overrides) {
        if (used.has(field.name)) continue;
        body.append(field.name, String(overrides[field.name]));
        used.add(field.name);
      } else {
        body.append(field.name, field.value);
      }
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (!used.has(name)) body.append(name, String(value));
    }

    try {
      const response = await fetch(BASE + path, {
        method: "POST",
        headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
        body,
        redirect: "manual",
      });
      if (response.status === 500) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      return {
        status: response.status,
        location: response.headers.get("x-action-redirect") ?? response.headers.get("location"),
        html: await response.text(),
      };
    } catch {
      await sleep(400 * (attempt + 1));
    }
  }
  throw new Error(`POST ${path} never succeeded`);
}

// ── Tiny HTML reading ───────────────────────────────────────────────────────

/**
 * Attribute values arrive HTML-escaped, and Next's action metadata is JSON —
 * `$ACTION_n:0` is `{&quot;id&quot;:&quot;…`. Post that back without decoding and
 * the action id is unparseable, which surfaces as a 500 that looks exactly like
 * a dropped connection. Decode before sending.
 */
function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Every <form> on the page with the fields that belong to it. */
function forms(html) {
  return [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((match) => {
    const inner = match[1];
    const fields = [];

    for (const tag of inner.match(/<input\b[^>]*>/g) ?? []) {
      const name = tag.match(/name="([^"]*)"/)?.[1];
      if (!name) continue;
      fields.push({
        name,
        value: decodeEntities(tag.match(/value="([^"]*)"/)?.[1] ?? ""),
        type: tag.match(/type="([^"]*)"/)?.[1] ?? "text",
        checked: /\bchecked\b/.test(tag),
        disabled: /\bdisabled\b/.test(tag),
      });
    }

    for (const select of inner.match(/<select\b[\s\S]*?<\/select>/g) ?? []) {
      const name = select.match(/name="([^"]*)"/)?.[1];
      if (!name) continue;
      const chosen = decodeEntities(
        select.match(/<option value="([^"]*)"[^>]*\bselected\b/)?.[1] ??
          select.match(/<option value="([^"]*)"/)?.[1] ??
          "",
      );
      fields.push({ name, value: chosen, type: "select", checked: false, disabled: false });
    }

    return { text: inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), fields, inner };
  });
}

/** The form whose visible text contains `needle` — how a person would find it. */
function formWith(html, needle) {
  const found = forms(html).find((form) => form.text.includes(needle));
  if (!found) throw new Error(`no form containing "${needle}"`);
  return found;
}

/** The <Alert> banners an action rendered back. */
function alerts(html) {
  return [...html.matchAll(/role="alert"[^>]*>([\s\S]*?)<\/p>/g)]
    .map((match) => match[1].replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);
}

const says = (html, fragment) => alerts(html).some((alert) => alert.includes(fragment));

// ── Session ─────────────────────────────────────────────────────────────────

async function openSession() {
  if (usingForm) {
    return signIn();
  }

  const user = await db(() => prisma.user.findFirst({
    where: { email: "owner@hopedemo.edu.gh", deletedAt: null },
    include: { memberships: true },
  }));
  if (!user) {
    throw new Error("demo owner not found — run `npm run db:seed` first");
  }
  const token = randomBytes(32).toString("hex");
  await db(() => prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      activeSchoolId: user.memberships[0]?.schoolId,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  }));
  return { token, userId: user.id, schoolId: user.memberships[0]?.schoolId ?? null };
}

/** Sign in the way a person does, so no database access is needed. */
async function signIn() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const page = await fetchPage("/login", "");
    const body = new FormData();
    for (const field of formWith(page.html, "Sign in").fields) {
      if (field.name === "identifier" || field.name === "password") continue;
      body.append(field.name, field.value);
    }
    body.append("identifier", EMAIL);
    body.append("password", PASSWORD);

    const response = await fetch(BASE + "/login", { method: "POST", body, redirect: "manual" });
    const html = await response.text();
    const raw = response.headers.getSetCookie?.().find((c) => c.includes(COOKIE_NAME));
    const token = raw?.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))?.[1];
    if (token) {
      return { token, userId: null };
    }
    if (response.status !== 500) {
      throw new Error(`sign-in failed: ${alerts(html)[0] ?? `HTTP ${response.status}`}`);
    }
    await sleep(500 * (attempt + 1));
  }
  throw new Error("sign-in never succeeded");
}

async function closeSession(token) {
  if (usingForm) {
    // The session belongs to a real account; sign out rather than deleting rows.
    await fetch(BASE + "/login", { headers: { Cookie: `${COOKIE_NAME}=${token}` } }).catch(() => {});
    return;
  }
  try {
    await db(() =>
      prisma.session.deleteMany({
        where: { tokenHash: createHash("sha256").update(token).digest("hex") },
      }),
    );
  } catch {
    console.log("  --   could not delete the verification session; it expires in 30 minutes");
  }
}

/**
 * Checks that need no fixtures, so they run against any environment including a
 * freshly deployed, empty one. These are the ones worth running after a deploy:
 * they prove the app booted (which on production means the tenant-isolation
 * guard in src/lib/prisma.ts was satisfied, since it throws otherwise) and that
 * the auth gate is actually closed.
 */
async function deploymentChecks(cookie) {
  console.log("\nDeployment");

  const login = await fetchPage("/login", "");
  check("the login page renders", login.status === 200 && login.html.includes('name="identifier"'), BASE);

  for (const path of ["/dashboard", "/students", "/settings"]) {
    const anon = await fetchPage(path, "");
    check(
      `${path} is closed to anonymous requests`,
      anon.status >= 300 && anon.status < 400,
      `HTTP ${anon.status}`,
    );
  }

  // Reaching any authenticated page at all proves the app started, and a
  // production build only starts when APP_DATABASE_URL and DB_RLS are set.
  const landing = await fetchPage("/admin", cookie);
  const dashboard = landing.status === 200 ? landing : await fetchPage("/dashboard", cookie);
  check(
    "an authenticated session reaches the app",
    dashboard.status === 200,
    `HTTP ${dashboard.status}`,
  );
}

// ── The checks ──────────────────────────────────────────────────────────────

async function gradingGuards(cookie, schoolId) {
  console.log("\nGrading scales");
  if (!hasDb) {
    console.log("  --   no database access from here; these need fixtures to assert against");
    return;
  }
  const { html } = await fetchPage("/settings/grading", cookie);

  // ⚠️ Scope every fixture to the school the session is in. This connection is
  // the owner's, so it sees every school, and an unscoped pick once returned
  // another school's scale: the probe band was then written onto it.
  // The id comes from openSession, the same value the session was minted with,
  // so it cannot differ from the school the app authorises against.
  if (!schoolId) {
    console.log("  --   cannot tell which school the session is in, skipping");
    return;
  }

  const frozen = await db(() => prisma.gradingScale.findFirst({
    where: { schoolId, subjectResults: { some: {} } },
    select: { id: true, name: true, _count: { select: { subjectResults: true } } },
  }));
  // Another school's scale: its id is valid, but it is not ours. The band must
  // be refused outright, not waved through because the freeze guard counted
  // zero results on a scale row security hides from this session.
  const foreign = await db(() => prisma.gradingScale.findFirst({
    where: { schoolId: { not: schoolId } },
    select: { id: true },
  }));
  const addBandForm = forms(html).find((form) => form.text.includes("Add band"));
  if (foreign && addBandForm) {
    const foreignBand = await postForm(
      "/settings/grading",
      addBandForm,
      {
        gradingScaleId: foreign.id,
        grade: "ZZ",
        minScore: "0",
        maxScore: "1",
        points: "1",
        remark: "verification probe",
      },
      cookie,
    );
    check(
      "a band posted against another school's scale is refused",
      says(foreignBand.html, "not found"),
      alerts(foreignBand.html)[0],
    );
  } else {
    console.log("  --   no second school, or no band form on this page, skipping the foreign-scale check");
  }

  if (!frozen) {
    console.log("  --   no graded scale in this database, skipping the freeze checks");
    return;
  }

  check(
    "a graded scale renders no band editor",
    !html.includes(`value="${frozen.id}"`) || !formWith(html, "Add band").inner.includes(frozen.id),
    `${frozen.name}, ${frozen._count.subjectResults} results`,
  );

  // Forge the scale id: the UI never offers this, which is exactly why it needs
  // checking — the refusal has to live in the action, not the markup.
  const addBand = formWith(html, "Add band");
  const forged = await postForm(
    "/settings/grading",
    addBand,
    {
      gradingScaleId: frozen.id,
      grade: "ZZ",
      minScore: "0",
      maxScore: "1",
      points: "1",
      remark: "verification probe",
    },
    cookie,
  );
  check(
    "a forged band write against a graded scale is refused",
    says(forged.html, "already graded"),
    alerts(forged.html)[0],
  );

  const editable = await db(() => prisma.gradingScale.findFirst({
    where: { schoolId, subjectResults: { none: {} }, bands: { some: {} } },
    include: { bands: { orderBy: { minScore: "desc" } } },
  }));
  if (editable && editable.bands.length >= 2) {
    const top = editable.bands[0];
    const overlap = await postForm(
      "/settings/grading",
      addBand,
      {
        gradingScaleId: editable.id,
        grade: "ZZ",
        minScore: String(top.minScore),
        maxScore: String(top.maxScore),
        points: "1",
        remark: "verification probe",
      },
      cookie,
    );
    check(
      "an overlapping band is refused",
      says(overlap.html, "overlaps"),
      alerts(overlap.html)[0],
    );

    const backwards = await postForm(
      "/settings/grading",
      addBand,
      {
        gradingScaleId: editable.id,
        grade: "ZZ",
        minScore: "80",
        maxScore: "20",
        points: "1",
        remark: "verification probe",
      },
      cookie,
    );
    check(
      "a band whose floor is above its ceiling is refused",
      says(backwards.html, "cannot be above"),
      alerts(backwards.html)[0],
    );
  }
}

async function accountGuards(cookie, userId) {
  console.log("\nAccounts");
  if (!hasDb) {
    console.log("  --   no database access from here; these need fixtures to assert against");
    return;
  }
  if (!userId) {
    console.log("  --   signed in through the form, so the account under test is unknown");
    return;
  }
  const owners = await db(() => prisma.membership.count({ where: { role: "OWNER", status: "ACTIVE" } }));
  const path = `/users/${userId}`;
  const { html } = await fetchPage(path, cookie);

  if (owners === 1) {
    const demote = await postForm(path, formWith(html, "Save roles"), { roles: "TEACHER" }, cookie);
    check(
      "the last proprietor cannot be demoted",
      says(demote.html, "last proprietor"),
      alerts(demote.html)[0],
    );
  } else {
    console.log(`  --   ${owners} proprietors exist, skipping the lockout check`);
  }

  const suspend = await postForm(path, formWith(html, "Suspend account"), {}, cookie);
  check(
    "you cannot suspend your own account",
    suspend.location?.includes("error=self") ?? false,
    suspend.location ?? "no redirect",
  );

  const remove = await postForm(path, formWith(html, "Remove access"), {}, cookie);
  check(
    "you cannot remove your own access",
    remove.location?.includes("error=self") ?? false,
    remove.location ?? "no redirect",
  );

  const after = await db(() => prisma.membership.findMany({ where: { userId }, select: { role: true, status: true } }));
  check(
    "the account survived all three refusals",
    after.some((m) => m.role === "OWNER" && m.status === "ACTIVE"),
    after.map((m) => `${m.role}:${m.status}`).join(" "),
  );
}

async function studentGuards(cookie) {
  console.log("\nStudents");
  if (!hasDb) {
    console.log("  --   no database access from here; these need fixtures to assert against");
    return;
  }
  const billed = await db(() => prisma.student.findFirst({
    where: { deletedAt: null, invoices: { some: { status: { not: "CANCELLED" } } } },
    select: { id: true, admissionNo: true },
  }));
  if (!billed) {
    console.log("  --   no billed student, skipping the delete guard");
    return;
  }

  const path = `/students/${billed.id}`;
  const { html } = await fetchPage(path, cookie);
  const del = await postForm(path, formWith(html, "Delete record"), {}, cookie);
  check(
    "a billed student cannot be deleted",
    del.location?.includes("error=has-money") ?? false,
    `${billed.admissionNo} → ${del.location ?? "no redirect"}`,
  );

  const still = await db(() => prisma.student.findUnique({
    where: { id: billed.id },
    select: { deletedAt: true },
  }));
  check("the student is still on file", still?.deletedAt === null, billed.admissionNo);
}

/**
 * Deleting a duplicate: refused while its invoice is live, allowed once the
 * bursar has cancelled it, and the pupil then leaves their class.
 *
 * ⚠️ Both halves were broken. Cancelled invoices counted as "money on file", so
 * a duplicate billed before anyone noticed could never be deleted. And a delete
 * set `deletedAt` and nothing else, so the pupil left /students but stayed on
 * the class register, the mark sheets and the broadsheet, which read the roll
 * from ENROLMENTS — reported by a school whose duplicate in JHS 2 "would not
 * delete".
 *
 * Writes a fixture pupil and removes it again in `finally`; the delete itself is
 * the thing under test, so it cannot be a refusal-only check.
 */
async function deleteGuards(cookie) {
  console.log("\nDeleting a duplicate pupil");
  if (!hasDb) {
    console.log("  --   no database access from here; this needs a pupil it may create and remove");
    return;
  }
  const membership = await db(() =>
    prisma.membership.findFirst({ where: { user: { email: "owner@hopedemo.edu.gh" } } }),
  );
  const schoolId = membership.schoolId;
  const enrolled = await db(() =>
    prisma.enrollment.findFirst({
      where: { schoolId, status: "ACTIVE", academicYear: { isCurrent: true }, student: { deletedAt: null } },
      select: {
        classGroupId: true,
        academicYearId: true,
        student: { select: { firstName: true, lastName: true } },
      },
    }),
  );
  const term = await db(() => prisma.term.findFirst({ where: { schoolId, isCurrent: true } }));
  if (!enrolled || !term) {
    console.log("  --   no current class or term, skipping");
    return;
  }

  const stamp = Date.now();
  const student = await db(() =>
    prisma.student.create({
      data: {
        schoolId,
        admissionNo: `VERIFY-DUP-${stamp}`,
        firstName: "Verify",
        lastName: `Duplicate${stamp}`,
        gender: "MALE",
        currentClassGroupId: enrolled.classGroupId,
      },
    }),
  );
  try {
    await db(() =>
      prisma.enrollment.create({
        data: {
          schoolId,
          studentId: student.id,
          academicYearId: enrolled.academicYearId,
          classGroupId: enrolled.classGroupId,
        },
      }),
    );
    const invoice = await db(() =>
      prisma.invoice.create({
        data: {
          schoolId,
          studentId: student.id,
          termId: term.id,
          invoiceNo: `VERIFY-${stamp}`,
          status: "ISSUED",
          total: 100,
          balance: 100,
          subtotal: 100,
        },
      }),
    );

    const path = `/students/${student.id}`;
    const live = await postForm(path, formWith((await fetchPage(path, cookie)).html, "Delete record"), {}, cookie);
    check(
      "a duplicate with a LIVE invoice is refused",
      live.location?.includes("error=has-money") ?? false,
      live.location ?? "no redirect",
    );
    const refused = await fetchPage(`${path}?error=has-money`, cookie);
    check(
      "and the refusal names the invoice and who cancels it",
      refused.html.includes(invoice.invoiceNo) && refused.html.includes("ask the bursar"),
    );

    // What the bursar does on /invoices.
    await db(() => prisma.invoice.update({ where: { id: invoice.id }, data: { status: "CANCELLED" } }));

    const del = await postForm(path, formWith((await fetchPage(path, cookie)).html, "Delete record"), {}, cookie);
    check(
      "once the invoice is cancelled, the duplicate can be deleted",
      (del.location ?? "").endsWith("/students"),
      del.location ?? "no redirect",
    );
    const after = await db(() =>
      prisma.student.findUnique({
        where: { id: student.id },
        select: { deletedAt: true, currentClassGroupId: true, enrollments: { select: { status: true } } },
      }),
    );
    check("it is marked deleted", Boolean(after?.deletedAt));
    check("and has left its class", after?.currentClassGroupId === null, String(after?.currentClassGroupId));
    check(
      "and its enrolment is ended, so registers and results drop it",
      (after?.enrollments ?? []).every((row) => row.status !== "ACTIVE"),
      (after?.enrollments ?? []).map((row) => row.status).join(","),
    );

    const day = term.startDate.toISOString().slice(0, 10);
    const register = await fetchPage(`/attendance?class=${enrolled.classGroupId}&date=${day}`, cookie);
    check(
      "the class register still lists its real pupils",
      register.html.includes(enrolled.student.lastName),
      `${enrolled.student.firstName} ${enrolled.student.lastName}`,
    );
    check("but not the deleted duplicate", !register.html.includes(`Duplicate${stamp}`));

    // A school that deleted the REAL copy — or both — needs the way back.
    const roster = await fetchPage(`/classes/${enrolled.classGroupId}`, cookie);
    const rosterRow = roster.html.split(student.admissionNo)[1]?.split("</tr>")[0] ?? "";
    check("the class roster says the pupil was deleted, not withdrawn", rosterRow.includes(">deleted<"));
    const gone = await fetchPage(path, cookie);
    check("a deleted pupil's link opens, rather than a 404", gone.status === 200, `HTTP ${gone.status}`);
    check("and says it was deleted", gone.html.includes("was deleted on"));
    const restore = await postForm(path, formWith(gone.html, "Restore Verify"), {}, cookie);
    check("and offers to restore it", (restore.location ?? "").includes("restored=1"), restore.location ?? "no redirect");
    const back = await db(() =>
      prisma.student.findUnique({
        where: { id: student.id },
        select: { deletedAt: true, currentClassGroupId: true, enrollments: { select: { status: true } } },
      }),
    );
    check("a restored pupil is no longer deleted", back?.deletedAt === null);
    check("and is back in their class", back?.currentClassGroupId === enrolled.classGroupId, String(back?.currentClassGroupId));
    check(
      "with the enrolment the delete ended reopened",
      (back?.enrollments ?? []).every((row) => row.status === "ACTIVE"),
      (back?.enrollments ?? []).map((row) => row.status).join(","),
    );

    // A pupil genuinely withdrawn BEFORE being deleted stays withdrawn.
    await db(() => prisma.enrollment.updateMany({ where: { studentId: student.id }, data: { status: "WITHDRAWN" } }));
    await db(() =>
      prisma.student.update({ where: { id: student.id }, data: { currentClassGroupId: null, deletedAt: new Date(Date.now() + 60_000) } }),
    );
    await postForm(path, formWith((await fetchPage(path, cookie)).html, "Restore Verify"), {}, cookie);
    const kept = await db(() =>
      prisma.student.findUnique({
        where: { id: student.id },
        select: { deletedAt: true, currentClassGroupId: true, enrollments: { select: { status: true } } },
      }),
    );
    check(
      "but an enrolment ended before the delete stays ended",
      kept?.deletedAt === null && kept?.currentClassGroupId === null && (kept?.enrollments ?? []).every((row) => row.status === "WITHDRAWN"),
      (kept?.enrollments ?? []).map((row) => row.status).join(","),
    );
  } finally {
    // Cascades the enrolment and the invoice.
    await db(() => prisma.student.delete({ where: { id: student.id } }));
    await db(() => prisma.auditLog.deleteMany({ where: { entityId: student.id } }));
  }
}

async function structureGuards(cookie) {
  console.log("\nSchool structure");
  if (!hasDb) {
    console.log("  --   no database access from here; these need fixtures to assert against");
    return;
  }
  const { html } = await fetchPage("/settings/structure", cookie);

  const inUse = await db(() => prisma.level.count({ where: { classGroups: { some: {} } } }));
  const deleteForms = forms(html).filter((form) => form.text.includes("Delete level")).length;
  check(
    "levels that hold classes offer no delete button",
    inUse === 0 || deleteForms < inUse,
    `${inUse} levels in use, ${deleteForms} delete buttons rendered`,
  );

  const addLevel = formWith(html, "Add level");
  const blank = await postForm("/settings/structure", addLevel, { name: "  ", code: "ZZZ" }, cookie);
  check(
    "server-side validation catches a blank name",
    says(blank.html, "Give the level a name"),
    alerts(blank.html)[0],
  );
}

async function feeGuards(cookie) {
  console.log("\nFee items");
  if (!hasDb) {
    console.log("  --   no database access from here; these need fixtures to assert against");
    return;
  }
  const { html } = await fetchPage("/fees", cookie);

  const before = await db(() => prisma.feeCategory.count());
  check("the fee items card lists the school's items", html.includes("Fee items ·"), `${before} items`);

  // A fee item that is already priced or billed must not offer a delete: it
  // would cascade the structure lines away and silently change what a level
  // costs.
  const inUse = await db(() =>
    prisma.feeCategory.count({
      where: { OR: [{ structureItems: { some: {} } }, { invoiceItems: { some: {} } }] },
    }),
  );
  const deleteForms = forms(html).filter((form) => form.text.includes("Delete item")).length;
  check(
    "a priced or billed fee item offers no delete button",
    inUse === 0 || deleteForms <= before - inUse,
    `${inUse} of ${before} in use, ${deleteForms} delete buttons rendered`,
  );

  const addItem = formWith(html, "Add fee item");
  const blank = await postForm("/fees", addItem, { name: "   " }, cookie);
  check(
    "a blank fee item name is refused",
    says(blank.html, "Give the fee item a name"),
    alerts(blank.html)[0],
  );

  const existing = await db(() => prisma.feeCategory.findFirst({ orderBy: { order: "asc" } }));
  if (existing) {
    const dupe = await postForm("/fees", addItem, { name: existing.name }, cookie);
    check(
      "a duplicate fee item is refused rather than shadowing the original",
      says(dupe.html, "already a fee item called"),
      alerts(dupe.html)[0],
    );
  }

  check(
    "nothing was written by these refusals",
    (await db(() => prisma.feeCategory.count())) === before,
  );
}

/**
 * A school that has not paid can READ but not WRITE — through a real sign-in and
 * a real form post, which is the only path that proves it.
 *
 * ⚠️ Every earlier test of this called `runWithTenantContext({ readOnly: true })`
 * around the write, and that wrapper is exactly what a server action does not
 * have: requireAuth's context never reached the action's frame, every action
 * wrote with the flag unset, and an expired trial went on entering data under a
 * banner saying it could not. CI's own demo school had been read-only for five
 * days (the seed's trial ended on a fixed date) with every write test green.
 *
 * The one exception to "nothing here writes": the school is flipped to an
 * expired trial for the length of this section and put back in `finally`, and
 * the export's audit row is deleted. Both are fixtures, not results.
 */
async function readOnlyGuards(cookie) {
  console.log("\nRead-only school");
  if (!hasDb) {
    console.log("  --   no database access from here; this needs a school it may switch off");
    return;
  }
  const membership = await db(() =>
    prisma.membership.findFirst({ where: { user: { email: "owner@hopedemo.edu.gh" } } }),
  );
  const school = await db(() =>
    prisma.school.findUnique({
      where: { id: membership.schoolId },
      select: { id: true, subscriptionStatus: true, trialEndsAt: true },
    }),
  );
  const started = new Date();
  const probe = `Read-only probe ${Date.now()}`;

  try {
    await db(() =>
      prisma.school.update({
        where: { id: school.id },
        data: { subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() - 86_400_000) },
      }),
    );

    const page = await fetchPage("/fees", cookie);
    check("a read-only school still opens its pages", page.status === 200);
    check(
      "and is told why it cannot save",
      page.html.includes("read-only"),
      "the subscription notice in the layout",
    );

    // Posted once, by hand: postForm retries a 500 as a dropped connection, and
    // a refusal thrown by prisma.ts arrives as exactly that.
    const before = await db(() => prisma.feeCategory.count());
    const form = formWith(page.html, "Add fee item");
    const body = new FormData();
    for (const field of form.fields) {
      if (field.name !== "name") body.append(field.name, field.value);
    }
    body.append("name", probe);
    const response = await fetch(BASE + "/fees", {
      method: "POST",
      headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
      body,
      redirect: "manual",
    });
    const html = await response.text();
    const written = await db(() => prisma.feeCategory.count({ where: { name: probe } }));
    check(
      "a server action WRITE is refused",
      written === 0 && (await db(() => prisma.feeCategory.count())) === before,
      written ? "the fee item was created" : `HTTP ${response.status}`,
    );
    check("and does not report success", !says(html, "added"), alerts(html)[0] ?? "no banner");

    // Leaving is a read: a school that stopped paying can still take its data.
    const exported = await fetch(BASE + "/api/export/students", {
      headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
      redirect: "manual",
    });
    const csv = await exported.text();
    check(
      "but the export still downloads",
      exported.status === 200 && csv.split("\n").length > 1,
      `HTTP ${exported.status}`,
    );
  } finally {
    await db(() =>
      prisma.school.update({
        where: { id: school.id },
        data: { subscriptionStatus: school.subscriptionStatus, trialEndsAt: school.trialEndsAt },
      }),
    );
    await db(() => prisma.feeCategory.deleteMany({ where: { name: probe } }));
    await db(() =>
      prisma.auditLog.deleteMany({
        where: { schoolId: school.id, action: "data.export", createdAt: { gte: started } },
      }),
    );
  }
}

async function billChecks(cookie) {
  console.log("\nPrinted bills");
  if (!hasDb) {
    console.log("  --   no database access from here; these need fixtures to assert against");
    return;
  }

  const invoice = await db(() =>
    prisma.invoice.findFirst({
      where: { status: { not: "CANCELLED" } },
      include: { student: true },
      orderBy: { invoiceNo: "asc" },
    }),
  );
  if (!invoice) {
    console.log("  --   no invoices in this database to print");
    return;
  }

  const { html } = await fetchPage(
    `/invoices/print?term=${invoice.termId}&one=${invoice.id}`,
    cookie,
  );
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

  check("a bill names the student and their admission number",
    text.includes(invoice.student.firstName) && text.includes(invoice.student.admissionNo),
    invoice.student.admissionNo);
  check("and carries its invoice number", text.includes(invoice.invoiceNo), invoice.invoiceNo);
  check("and a stub the parent brings back", text.includes("Detach and return with payment"));
  check("exactly one bill, so no stray page break",
    !html.includes("print:break-after-page"));

  // The app chrome must not print — it did, on report cards too.
  check("the sidebar is hidden when printing", html.includes("print:lg:hidden"));
  check("the top bar is hidden when printing", html.includes("print:hidden"));

  const cancelled = await db(() => prisma.invoice.findFirst({ where: { status: "CANCELLED" } }));
  if (cancelled) {
    const batch = await fetchPage(`/invoices/print?term=${cancelled.termId}`, cookie);
    check("a cancelled invoice is never in a batch — it is not money owed",
      !batch.html.includes(cancelled.invoiceNo), cancelled.invoiceNo);
  }

  const noTerm = await fetchPage("/invoices/print", cookie);
  check("printing without a term is refused", noTerm.status === 404, `HTTP ${noTerm.status}`);
}

async function componentChecks(cookie) {
  console.log("\nAssessment components");
  if (!hasDb) {
    console.log("  --   no database access from here; these need fixtures to assert against");
    return;
  }

  const before = await db(() => prisma.assessmentTemplate.count());
  const settings = await fetchPage("/settings/components", cookie);
  check("the components screen renders", settings.status === 200, `${before} components`);
  check(
    "it explains that marks are the weighting, with no second concept to set",
    /no separate weighting to set/.test(settings.html),
  );

  const add = formWith(settings.html, "Add component");
  const blank = await postForm("/settings/components", add, { title: "  ", maxScore: "20" }, cookie);
  check(
    "a component with no name is refused",
    says(blank.html, "Give the component a name"),
    alerts(blank.html)[0],
  );

  const zero = await postForm("/settings/components", add, { title: "Probe", maxScore: "0" }, cookie);
  check(
    "a component worth zero marks is refused — it could never affect a grade",
    says(zero.html, "Total marks must be between 1 and 1000"),
    alerts(zero.html)[0],
  );

  const existing = await db(() => prisma.assessmentTemplate.findFirst({ orderBy: { order: "asc" } }));
  if (existing) {
    const dupe = await postForm(
      "/settings/components",
      add,
      { title: existing.title, maxScore: "20" },
      cookie,
    );
    check(
      "a duplicate component name is refused",
      says(dupe.html, "already a component called"),
      alerts(dupe.html)[0],
    );
  }

  check(
    "nothing was written by these refusals",
    (await db(() => prisma.assessmentTemplate.count())) === before,
  );

  // The sheet itself: a score above a component's total must never be stored.
  const assessment = await db(() =>
    prisma.assessment.findFirst({
      where: { status: { not: "APPROVED" } },
      orderBy: { createdAt: "desc" },
    }),
  );
  if (!assessment) {
    console.log("  --   no open assessment to range-check against");
    return;
  }
  const sheetPath = `/assessments/sheet?term=${assessment.termId}&class=${assessment.classGroupId}&subject=${assessment.subjectId}`;
  const sheet = await fetchPage(sheetPath, cookie);
  check("the mark sheet renders", sheet.status === 200, `HTTP ${sheet.status}`);

  const student = await db(() =>
    prisma.student.findFirst({
      where: { currentClassGroupId: assessment.classGroupId, status: "ACTIVE", deletedAt: null },
    }),
  );
  if (student && sheet.html.includes("Save the sheet")) {
    const scores = await db(() => prisma.score.count({ where: { assessmentId: assessment.id } }));
    const tooBig = Number(assessment.maxScore) + 1;
    const refused = await postForm(
      sheetPath,
      formWith(sheet.html, "Save the sheet"),
      { [`score:${assessment.id}:${student.id}`]: String(tooBig) },
      cookie,
    );
    check(
      "a mark above the component's total is refused",
      says(refused.html, "is above it"),
      alerts(refused.html)[0],
    );
    check(
      "and the refusal wrote nothing",
      (await db(() => prisma.score.count({ where: { assessmentId: assessment.id } }))) === scores,
    );
  }
}

async function importChecks(cookie) {
  console.log("\nStudent import (preview only — writes nothing)");
  if (!hasDb) {
    console.log("  --   no database access from here; these need fixtures to assert against");
    return;
  }
  const { html } = await fetchPage("/students/import", cookie);

  const existing = await db(() => prisma.student.findFirst({
    where: { deletedAt: null },
    select: { admissionNo: true },
  }));

  const csv = [
    "first_name,last_name,gender,class,admission_no,guardian_name,guardian_phone",
    "Verify,Probe,F,,,,",
    "NoGender,Probe,,,,,",
    `Duplicate,Probe,M,,${existing?.admissionNo ?? "HEC/0001"},,`,
    "BadClass,Probe,M,Nowhere Z,,,",
  ].join("\n");

  const preview = await postForm("/students/import", formWith(html, "Check the file"), { csv }, cookie);
  const banner = alerts(preview.html).find((a) => a.includes("rows read")) ?? "";
  check("the preview reads every row", banner.includes("4 rows read"), banner);
  check("a row with no gender is blocked", preview.html.includes("gender must be M or F"));
  check("a duplicate admission number is blocked", preview.html.includes("already exists"));
  check("an unknown class is blocked", preview.html.includes("no class called"));
  // The importable row here has warnings (no class, no guardian) but no errors,
  // which is the distinction that matters: warnings never cost you a child.
  check(
    "a row with warnings but no errors still counts as importable",
    banner.includes("1 ready") && banner.includes("3 with problems"),
    banner,
  );
  check(
    "nothing was written by the preview",
    (await db(() => prisma.student.count({ where: { lastName: "Probe" } }))) === 0,
  );
}

// ── Run ─────────────────────────────────────────────────────────────────────

// ── Ids from another school ────────────────────────────────────────────────
//
// Row security hides another school's rows from a READ; it does not stop a WRITE
// that points at one (foreign-reference checks ignore it, and the new row carries
// the caller's own schoolId). So every action that writes an id taken from a form
// must read it back first. These checks post another school's real ids to the
// actions that were found without that read (2026-10-10) and assert a refusal.
//
// ⚠️ They need a SECOND school to point at, and CI seeds exactly one. Rather than
// skip there — which is where the previous version of this check lived, and an
// assertion that never runs is not one — the fixture is made here: a throw-away
// school with just the rows an id can point at, deleted again in `finally`. It is
// the only thing in this file that writes, and it writes to a school nobody uses.

// ⚠️ This script may be pointed at a database that holds real schools, so it
// deletes only what it made. The slug is random per run and the school is removed
// BY ID. A run killed half way leaves its school behind, so leftovers are swept
// at the start — recognised by the prefix AND the exact name together, which no
// school anyone registered will have. A fixed slug deleted by slug, as the first
// version did, would remove a real school that happened to be called that.
const PROBE_NAME = "ZZZ verify:actions foreign-id probe (safe to delete)";
const PROBE_SLUG_PREFIX = "zzz-verify-foreign-ids-";

async function withForeignSchool(run) {
  await db(() =>
    prisma.school.deleteMany({ where: { slug: { startsWith: PROBE_SLUG_PREFIX }, name: PROBE_NAME } }),
  );
  const school = await db(() =>
    prisma.school.create({
      data: { name: PROBE_NAME, slug: `${PROBE_SLUG_PREFIX}${randomBytes(4).toString("hex")}` },
    }),
  );
  const remove = () => db(() => prisma.school.deleteMany({ where: { id: school.id } }));
  try {
    const schoolId = school.id;
    const year = await db(() =>
      prisma.academicYear.create({
        data: { schoolId, name: "2099/2100", startDate: new Date("2099-09-01"), endDate: new Date("2100-07-31") },
      }),
    );
    const term = await db(() =>
      prisma.term.create({
        data: {
          schoolId,
          academicYearId: year.id,
          name: "FIRST",
          sequence: 1,
          startDate: new Date("2099-09-01"),
          endDate: new Date("2099-12-15"),
        },
      }),
    );
    const level = await db(() =>
      prisma.level.create({ data: { schoolId, name: "Probe Level", code: "ZZ1", stage: "PRIMARY", order: 1 } }),
    );
    const classGroup = await db(() => prisma.classGroup.create({ data: { schoolId, levelId: level.id, name: "Probe" } }));
    const subject = await db(() => prisma.subject.create({ data: { schoolId, name: "Probe Subject", code: "ZZS" } }));
    const asset = await db(() =>
      prisma.ledgerAccount.create({ data: { schoolId, code: "9001", name: "Probe cash", type: "ASSET" } }),
    );
    const income = await db(() =>
      prisma.ledgerAccount.create({ data: { schoolId, code: "9002", name: "Probe income", type: "INCOME" } }),
    );
    const expense = await db(() =>
      prisma.ledgerAccount.create({ data: { schoolId, code: "9003", name: "Probe expense", type: "EXPENSE" } }),
    );
    const feeCategory = await db(() =>
      prisma.feeCategory.create({ data: { schoolId, name: "Probe fee", code: "ZZFEE" } }),
    );
    const expenseCategory = await db(() =>
      prisma.expenseCategory.create({ data: { schoolId, name: "Probe spend", code: "ZZSPEND" } }),
    );
    const house = await db(() => prisma.house.create({ data: { schoolId, name: "Probe House" } }));
    const programme = await db(() => prisma.programme.create({ data: { schoolId, name: "Probe Programme", code: "ZZPRG" } }));
    const student = await db(() =>
      prisma.student.create({
        data: { schoolId, admissionNo: "ZZ-0001", firstName: "Probe", lastName: "Pupil", gender: "MALE" },
      }),
    );
    const guardian = await db(() =>
      prisma.guardian.create({ data: { schoolId, firstName: "Probe", lastName: "Guardian", phone: "0200000000" } }),
    );
    const staff = await db(() =>
      prisma.staff.create({ data: { schoolId, staffNo: "ZZ-S-0001", firstName: "Probe", lastName: "Teacher", gender: "FEMALE" } }),
    );
    return await run({
      term, classGroup, subject, asset, income, expense, feeCategory, expenseCategory,
      house, programme, student, guardian, staff,
    });
  } finally {
    await remove();
  }
}

async function foreignIdGuards(cookie) {
  console.log("\nIds from another school");
  if (!hasDb) {
    console.log("  --   no database access from here; these need a second school to point at");
    return;
  }

  const session = await db(() =>
    prisma.session.findFirst({
      where: { tokenHash: createHash("sha256").update(cookie).digest("hex") },
      select: { activeSchoolId: true, user: { select: { memberships: { select: { schoolId: true }, take: 1 } } } },
    }),
  );
  const schoolId = session?.activeSchoolId ?? session?.user.memberships[0]?.schoolId;
  if (!schoolId) {
    console.log("  --   cannot tell which school the session is in, skipping");
    return;
  }

  await withForeignSchool(async (foreign) => {
    // ---- The ledger mapping: where every later posting lands ---------------
    const chart = await fetchPage("/chart-of-accounts", cookie);
    const KEYS = ["cashAccountId", "bankAccountId", "momoAccountId", "receivableAccountId", "payableAccountId"];
    const coreForm = forms(chart.html).find((f) => f.fields.some((x) => x.name === "cashAccountId"));
    if (!coreForm) {
      console.log("  --   no default-postings form on /chart-of-accounts, skipping the ledger checks");
    } else {
      const settingsNow = () => db(() => prisma.schoolSettings.findUnique({ where: { schoolId } }));
      const before = await settingsNow();
      const current = Object.fromEntries(KEYS.map((key) => [key, before?.[key] ?? ""]));

      try {

      const same = await postForm("/chart-of-accounts", coreForm, current, cookie);
      check("control: the unchanged default postings are accepted", says(same.html, "Default postings saved"), alerts(same.html)[0]);

      const refused = [];
      for (const key of KEYS) {
        const forged = await postForm("/chart-of-accounts", coreForm, { ...current, [key]: foreign.asset.id }, cookie);
        if (!says(forged.html, "chart of accounts")) refused.push(key);
      }
      check("another school's account is refused for every default posting", refused.length === 0, refused.length ? `accepted for ${refused.join(", ")}` : "5 of 5 refused");
      const after = await settingsNow();
      check("and the mapping is unchanged", KEYS.every((key) => (after?.[key] ?? null) === (before?.[key] ?? null)));
      } finally {
        // Unfixed, the forged posts WRITE a foreign id into columns that have no
        // foreign key, and deleting the probe school would leave it there for good.
        if (before) {
          await db(() => prisma.schoolSettings.update({ where: { schoolId }, data: Object.fromEntries(KEYS.map((key) => [key, before[key] ?? null])) }));
        }
      }

      for (const [kind, formKey, categoryKey, column, model, ownType, foreignAccount, foreignCategory] of [
        ["fee item", "feeCategoryId", "incomeAccountId", "incomeAccountId", "feeCategory", "INCOME", foreign.income, foreign.feeCategory],
        ["expense heading", "expenseCategoryId", "expenseAccountId", "expenseAccountId", "expenseCategory", "EXPENSE", foreign.expense, foreign.expenseCategory],
      ]) {
        const form = forms(chart.html).find((f) => f.fields.some((x) => x.name === formKey));
        const own = form ? await db(() => prisma[model].findUnique({ where: { id: form.fields.find((x) => x.name === formKey).value } })) : null;
        if (!form || !own) {
          console.log(`  --   no ${kind} to map on this page, skipping`);
          continue;
        }
        const alternative = await db(() =>
          prisma.ledgerAccount.findFirst({ where: { schoolId, type: ownType, id: { not: own[column] ?? "" } } }),
        );
        const read = () => db(() => prisma[model].findUnique({ where: { id: own.id } }).then((row) => row?.[column] ?? null));
        const original = await read();

        try {
          // These actions answer with nothing, so a refusal cannot be told from a
          // dropped request by its message. The control changes the mapping to a
          // real account of this school, proving the post reaches the action,
          // and the mapping is put back.
          if (alternative) {
            await postForm("/chart-of-accounts", form, { [categoryKey]: alternative.id }, cookie);
            check(`control: a ${kind} can be mapped to this school's own account`, (await read()) === alternative.id);
            await postForm("/chart-of-accounts", form, { [categoryKey]: original ?? "" }, cookie);
          } else {
            console.log(`  --   no second ${ownType.toLowerCase()} account to use as a control for the ${kind}`);
          }
          await postForm("/chart-of-accounts", form, { [categoryKey]: foreignAccount.id }, cookie);
          check(`another school's account is refused for a ${kind}`, (await read()) === original, `${(await read()) ?? "none"}`);

          // Unfixed, this throws inside the action (Prisma P2025: the row is hidden)
          // and the script's own retries give up; either way the row must survive.
          await postForm("/chart-of-accounts", form, { [formKey]: foreignCategory.id, [categoryKey]: alternative?.id ?? "" }, cookie, 1).catch(() => null);
          const theirs = await db(() => prisma[model].findUnique({ where: { id: foreignCategory.id } }));
          check(`another school's ${kind} cannot be remapped`, (theirs?.[column] ?? null) === null);
        } finally {
          await db(() => prisma[model].update({ where: { id: own.id }, data: { [column]: original } }));
        }
      }
    }

    // ---- Assessments: a title claimed on someone else's term ----------------
    const myClass = await db(() => prisma.classGroup.findFirst({ where: { schoolId }, orderBy: { createdAt: "asc" } }));
    const offered = myClass
      ? await db(() => prisma.levelSubject.findFirst({ where: { levelId: myClass.levelId, schoolId } }))
      : null;
    const myTerms = await db(() => prisma.term.findMany({ where: { schoolId }, orderBy: { startDate: "asc" } }));
    let free = null;
    for (const term of myTerms) {
      if (myClass && offered && (await db(() => prisma.assessment.count({ where: { termId: term.id, classGroupId: myClass.id, subjectId: offered.subjectId } }))) === 0) {
        free = term;
        break;
      }
    }
    const touching = () =>
      db(() =>
        prisma.assessment.count({
          where: { OR: [{ termId: foreign.term.id }, { classGroupId: foreign.classGroup.id }, { subjectId: foreign.subject.id }] },
        }),
      );

    if (!free) {
      console.log("  --   every class, subject and term here already has a sheet open, skipping the open-sheet check");
    } else {
      const page = await fetchPage(`/assessments/sheet?term=${free.id}&class=${myClass.id}&subject=${offered.subjectId}`, cookie);
      const openForm = forms(page.html).find((f) => f.fields.some((x) => x.name === "termId") && f.fields.some((x) => x.name === "subjectId"));
      if (!openForm) {
        console.log("  --   no Open the sheet form for an unopened sheet, skipping");
      } else {
        const sheetUrl = `/assessments/sheet?term=${free.id}&class=${myClass.id}&subject=${offered.subjectId}`;
        const results = [];
        for (const override of [{ termId: foreign.term.id }, { classGroupId: foreign.classGroup.id }, { subjectId: foreign.subject.id }]) {
          const forged = await postForm(sheetUrl, openForm, override, cookie);
          results.push(says(forged.html, "was not found"));
        }
        check("opening a sheet on another school's term, class or subject is refused", results.every(Boolean), results.map((r) => (r ? "refused" : "ACCEPTED")).join(", "));
        check("and no assessment was written against them", (await touching()) === 0);
      }
    }

    // New assessment form: it only renders after a click, so it is absent from the
    // server HTML. Flip `useState(false)` to `true` in new-assessment.tsx to run this.
    const list = await fetchPage("/assessments", cookie);
    const newForm = forms(list.html).find((f) => f.fields.some((x) => x.name === "maxScore"));
    if (!newForm) {
      console.log("  --   the new-assessment form is behind a click, so it is not on the page; skipping");
    } else {
      const forged = await postForm("/assessments", newForm, {
        termId: foreign.term.id,
        classGroupId: foreign.classGroup.id,
        subjectId: foreign.subject.id,
        title: "ZZ foreign probe",
        maxScore: "10",
      }, cookie);
      check("an assessment on another school's term, class and subject is refused", says(forged.html, "was not found"), alerts(forged.html)[0]);
      check("and nothing was written", (await touching()) === 0);
    }

    await peopleGuards(cookie, schoolId, foreign, myClass, offered);
    await financeGuards(cookie, schoolId, foreign);
    await subjectGuards(cookie, schoolId, foreign);
  });
}

/** The levels form for a subject: the subject id it posts must be this school's own. */
async function subjectGuards(cookie, schoolId, foreign) {
  console.log("\nSubject levels");
  const refusal = refusalOf(cookie);
  const offering = await db(() => prisma.levelSubject.findFirst({ where: { schoolId } }));
  if (!offering) {
    console.log("  --   no subject is offered at any level here, skipping");
    return;
  }
  const path = `/subjects/${offering.subjectId}`;
  const page = await fetchPage(path, cookie);
  const form = forms(page.html).find((f) => f.fields.some((x) => x.name === "offered"));
  if (!form) {
    console.log("  --   no levels form on the subject page, skipping");
    return;
  }
  const ok = await postForm(path, form, {}, cookie);
  check("control: saving this school's own subject unchanged is accepted", says(ok.html, "Offered at"), alerts(ok.html)[0]);
  const forged = await refusal(path, form, { subjectId: foreign.subject.id });
  check("another school's subject is refused", says(forged.html, "subject was not found"), alerts(forged.html)[0]);
  check(
    "and no level offers it",
    (await db(() => prisma.levelSubject.count({ where: { subjectId: foreign.subject.id } }))) === 0,
  );
}

/**
 * Money: the heading and term an expense, a vendor bill or a budget names must
 * be this school's own. The expense and bill forms open on a click, so they are
 * absent from the server HTML and skip unless `useState(false)` in
 * expense-form.tsx and bill-form.tsx is flipped to `true` for the run; the
 * budget panel renders on the page and always runs.
 */
async function financeGuards(cookie, schoolId, foreign) {
  console.log("\nMoney naming another school");
  const refusal = refusalOf(cookie);
  const tag = `ZZ verify:actions ${randomBytes(3).toString("hex")}`;

  // ---- Budgets ---------------------------------------------------------------
  const expensesPage = await fetchPage("/expenses", cookie);
  const budgetForm = forms(expensesPage.html).find(
    (f) => f.fields.some((x) => x.name === "categoryId" && x.type === "hidden") && f.fields.some((x) => x.name === "amount"),
  );
  if (!budgetForm) {
    console.log("  --   no budget row on /expenses (no current term or no headings), skipping the budget checks");
  } else {
    const termId = budgetForm.fields.find((x) => x.name === "termId").value;
    const categoryId = budgetForm.fields.find((x) => x.name === "categoryId").value;
    const key = { termId_categoryId: { termId, categoryId } };
    const before = await db(() => prisma.budget.findUnique({ where: key }));
    try {
      const ok = await postForm("/expenses", budgetForm, { amount: "123.45" }, cookie);
      // The panel prints its result in a plain paragraph, not an alert, so match the page text.
      check("control: a budget for this school's own term and heading is saved", ok.html.includes("Budget saved"));
      const badTerm = await refusal("/expenses", budgetForm, { termId: foreign.term.id, amount: "123.45" });
      check("a budget on another school's term is refused", badTerm.html.includes("term or heading was not found"));
      const badHeading = await refusal("/expenses", budgetForm, { categoryId: foreign.expenseCategory.id, amount: "123.45" });
      check("a budget on another school's heading is refused", badHeading.html.includes("term or heading was not found"));
      check(
        "and no budget row points at the other school",
        (await db(() => prisma.budget.count({ where: { OR: [{ termId: foreign.term.id }, { categoryId: foreign.expenseCategory.id }] } }))) === 0,
      );
    } finally {
      if (before) {
        await db(() => prisma.budget.update({ where: key, data: { amount: before.amount } }));
      } else {
        await db(() => prisma.budget.deleteMany({ where: { termId, categoryId } }));
      }
    }
  }

  // ---- Recording an expense -------------------------------------------------
  const expenseForm = forms(expensesPage.html).find(
    (f) => f.fields.some((x) => x.name === "description") && f.fields.some((x) => x.name === "categoryId" && x.type === "select"),
  );
  if (!expenseForm) {
    console.log("  --   the expense form is behind a click, so it is not on the page; skipping");
  } else {
    const description = `${tag} expense`;
    const mine = () => db(() => prisma.expense.findMany({ where: { schoolId, description }, select: { id: true } }));
    try {
      const ok = await postForm("/expenses", expenseForm, { description, amount: "1.00" }, cookie);
      check("control: an expense with this school's own heading and term is recorded", (await mine()).length === 1, alerts(ok.html)[0]);
      const badHeading = await refusal("/expenses", expenseForm, { description: `${description} h`, amount: "1.00", categoryId: foreign.expenseCategory.id });
      check("an expense under another school's heading is refused", says(badHeading.html, "heading was not found"), alerts(badHeading.html)[0]);
      const badTerm = await refusal("/expenses", expenseForm, { description: `${description} t`, amount: "1.00", termId: foreign.term.id });
      check("an expense in another school's term is refused", says(badTerm.html, "term was not found"), alerts(badTerm.html)[0]);
      check(
        "and no expense points at the other school",
        (await db(() => prisma.expense.count({ where: { OR: [{ categoryId: foreign.expenseCategory.id }, { termId: foreign.term.id }] } }))) === 0,
      );
    } finally {
      const rows = await db(() => prisma.expense.findMany({ where: { schoolId, description: { startsWith: tag } }, select: { id: true } }));
      const ids = rows.map((r) => r.id);
      await db(() => prisma.journalEntry.deleteMany({ where: { schoolId, sourceType: "EXPENSE", sourceId: { in: ids } } }));
      await db(() => prisma.auditLog.deleteMany({ where: { schoolId, entityId: { in: ids } } }));
      await db(() => prisma.expense.deleteMany({ where: { id: { in: ids } } }));
    }
  }

  // ---- Recording a vendor bill ----------------------------------------------
  const billPage = await fetchPage("/creditors", cookie);
  const billForm = forms(billPage.html).find(
    (f) => f.fields.some((x) => x.name === "vendorId") && f.fields.some((x) => x.name === "categoryId" && x.type === "select"),
  );
  if (!billForm) {
    console.log("  --   the vendor bill form is behind a click, or the school has no vendor, so skipping");
  } else {
    let vendor = await db(() => prisma.vendor.findFirst({ where: { schoolId, isActive: true } }));
    const madeVendor = !vendor;
    if (!vendor) {
      vendor = await db(() => prisma.vendor.create({ data: { schoolId, name: `${tag} vendor` } }));
    }
    const description = `${tag} bill`;
    const mine = () => db(() => prisma.vendorBill.findMany({ where: { schoolId, description }, select: { id: true } }));
    try {
      const ok = await postForm("/creditors", billForm, { vendorId: vendor.id, description, amount: "1.00" }, cookie);
      check("control: a bill under this school's own heading is recorded", (await mine()).length === 1, alerts(ok.html)[0]);
      const bad = await refusal("/creditors", billForm, { vendorId: vendor.id, description: `${description} x`, amount: "1.00", categoryId: foreign.expenseCategory.id });
      check("a bill under another school's heading is refused", says(bad.html, "heading was not found"), alerts(bad.html)[0]);
      check("and no bill points at the other school", (await db(() => prisma.vendorBill.count({ where: { categoryId: foreign.expenseCategory.id } }))) === 0);
    } finally {
      const rows = await db(() => prisma.vendorBill.findMany({ where: { schoolId, description: { startsWith: tag } }, select: { id: true } }));
      const ids = rows.map((r) => r.id);
      await db(() => prisma.auditLog.deleteMany({ where: { schoolId, entityId: { in: ids } } }));
      await db(() => prisma.vendorBill.deleteMany({ where: { id: { in: ids } } }));
      if (madeVendor) await db(() => prisma.vendor.deleteMany({ where: { id: vendor.id } }));
    }
  }
}

/**
 * Pupils, guardians and staff: the class, house, programme and person ids a
 * form names must all belong to the school. Each refusal is paired with a
 * control that the same post is accepted with this school's own ids, so a
 * dropped request cannot pass as a refusal.
 */
/** A forged post. Unfixed, the action throws and the page answers 500; that is a failed check, not a crash. */
const refusalOf = (cookie) => (path, form, overrides) => postForm(path, form, overrides, cookie, 1).catch(() => ({ html: "" }));

async function peopleGuards(cookie, schoolId, foreign, myClass, offered) {
  console.log("\nPeople from another school");
  const refusal = refusalOf(cookie);
  const own = await db(() => prisma.student.findFirst({ where: { schoolId, deletedAt: null }, orderBy: { createdAt: "asc" } }));
  if (!own || !myClass) {
    console.log("  --   this school has no pupil or class to post from, skipping");
    return;
  }

  // ---- Enrolling a pupil ---------------------------------------------------
  const studentPage = `/students/${own.id}`;
  const page = await fetchPage(studentPage, cookie);
  const enrolForm = forms(page.html).find((f) => f.fields.some((x) => x.name === "classGroupId") && f.fields.some((x) => x.name === "studentId"));
  const placedIn = () => db(() => prisma.student.findUnique({ where: { id: own.id }, select: { currentClassGroupId: true } }).then((r) => r?.currentClassGroupId ?? null));
  if (!enrolForm) {
    console.log("  --   no enrol form on the pupil page, skipping");
  } else if (!own.currentClassGroupId) {
    console.log("  --   the pupil has no class to restore afterwards, skipping the enrol checks");
  } else {
    const before = await placedIn();
    const okClass = await postForm(studentPage, enrolForm, { classGroupId: before }, cookie);
    check("control: enrolling a pupil in this school's own class is accepted", says(okClass.html, "Placed in class") || alerts(okClass.html).length === 0, alerts(okClass.html)[0]);
    const badClass = await refusal(studentPage, enrolForm, { classGroupId: foreign.classGroup.id });
    check("a class from another school is refused at enrolment", says(badClass.html, "class was not found"), alerts(badClass.html)[0]);
    const badStudent = await refusal(studentPage, enrolForm, { studentId: foreign.student.id, classGroupId: before });
    check("another school's pupil cannot be enrolled", says(badStudent.html, "student was not found"), alerts(badStudent.html)[0]);
    check(
      "and no enrolment points at the other school",
      (await placedIn()) === before &&
        (await db(() => prisma.enrollment.count({ where: { OR: [{ classGroupId: foreign.classGroup.id }, { studentId: foreign.student.id }] } }))) === 0,
    );
  }

  // ---- Editing a pupil's house and programme ------------------------------
  const editForm = forms(page.html).find((f) => f.fields.some((x) => x.name === "houseId") && f.fields.some((x) => x.name === "id"));
  if (!editForm) {
    console.log("  --   no edit form on the pupil page, skipping");
  } else {
    const snapshot = await db(() => prisma.student.findUnique({ where: { id: own.id }, select: { houseId: true, programmeId: true } }));
    try {
      const same = await postForm(studentPage, editForm, {}, cookie);
      check("control: saving a pupil with this school's own values is accepted", says(same.html, "Saved"), alerts(same.html)[0]);
      const house = await refusal(studentPage, editForm, { houseId: foreign.house.id });
      check("another school's house is refused", says(house.html, "house was not found"), alerts(house.html)[0]);
      const programme = await refusal(studentPage, editForm, { programmeId: foreign.programme.id });
      check("another school's programme is refused", says(programme.html, "programme was not found"), alerts(programme.html)[0]);
      const stranger = await refusal(studentPage, editForm, { id: foreign.student.id, firstName: "Overwritten" });
      check("another school's pupil cannot be edited", says(stranger.html, "student was not found"), alerts(stranger.html)[0]);
      const after = await db(() => prisma.student.findUnique({ where: { id: own.id }, select: { houseId: true, programmeId: true } }));
      const theirs = await db(() => prisma.student.findUnique({ where: { id: foreign.student.id } }));
      check("and nothing was written", after?.houseId === snapshot?.houseId && after?.programmeId === snapshot?.programmeId && theirs?.firstName === "Probe");
    } finally {
      await db(() => prisma.student.update({ where: { id: own.id }, data: snapshot ?? {} }));
    }
  }
  console.log("  --   the admit form is behind a click, so the admission checks are not driven from here");

  // ---- Linking a guardian ---------------------------------------------------
  const link = await db(() => prisma.studentGuardian.findFirst({ where: { schoolId }, orderBy: { createdAt: "asc" } }));
  if (!link) {
    console.log("  --   no guardian link to use as a control, skipping the link checks");
  } else {
    const guardianPage = `/guardians/${link.guardianId}`;
    const gpage = await fetchPage(guardianPage, cookie);
    const linkForm = forms(gpage.html).find((f) => f.fields.some((x) => x.name === "studentId") && f.fields.some((x) => x.name === "guardianId"));
    if (!linkForm) {
      console.log("  --   no link form on the guardian page, skipping");
    } else {
      const primaries = () => db(() => prisma.studentGuardian.findMany({ where: { studentId: link.studentId }, select: { id: true, isPrimary: true }, orderBy: { id: "asc" } }));
      const wasPrimary = await primaries();
      try {
        const okLink = await postForm(guardianPage, linkForm, { studentId: link.studentId, relationship: link.relationship, ...(link.isPrimary ? { isPrimary: "on" } : {}) }, cookie);
        check("control: linking this school's own pupil and guardian is accepted", says(okLink.html, "Linked"), alerts(okLink.html)[0]);
        const badStudent = await refusal(guardianPage, linkForm, { studentId: foreign.student.id, isPrimary: "on" });
        check("another school's pupil cannot be linked", says(badStudent.html, "student was not found"), alerts(badStudent.html)[0]);
        const badGuardian = await refusal(guardianPage, linkForm, { guardianId: foreign.guardian.id, studentId: link.studentId, isPrimary: "on" });
        check("another school's guardian cannot be linked", says(badGuardian.html, "guardian was not found"), alerts(badGuardian.html)[0]);
        const now = await primaries();
        check(
          "and the pupil's primary guardian was not demoted",
          JSON.stringify(now) === JSON.stringify(wasPrimary) &&
            (await db(() => prisma.studentGuardian.count({ where: { OR: [{ studentId: foreign.student.id }, { guardianId: foreign.guardian.id }] } }))) === 0,
        );
      } finally {
        for (const row of wasPrimary) {
          await db(() => prisma.studentGuardian.update({ where: { id: row.id }, data: { isPrimary: row.isPrimary } }));
        }
        await db(() =>
          prisma.studentGuardian.update({
            where: { id: link.id },
            data: {
              relationship: link.relationship,
              receivesBills: link.receivesBills,
              receivesReports: link.receivesReports,
              isEmergencyContact: link.isEmergencyContact,
            },
          }),
        );
      }
    }
  }

  // ---- Teaching assignments ---------------------------------------------------
  const staff = await db(() => prisma.staff.findFirst({ where: { schoolId }, orderBy: { createdAt: "asc" } }));
  if (!staff || !offered) {
    console.log("  --   no staff member or offered subject, skipping the assignment checks");
  } else {
    const staffPage = `/staff/${staff.id}`;
    const spage = await fetchPage(staffPage, cookie);
    const form = forms(spage.html).find((f) => f.fields.some((x) => x.name === "subjectId") && f.fields.some((x) => x.name === "staffId"));
    const year = await db(() => prisma.academicYear.findFirst({ where: { schoolId, isCurrent: true } }));
    if (!form || !year) {
      console.log("  --   no assignment form or current year, skipping");
    } else {
      const combo = { academicYearId: year.id, staffId: staff.id, subjectId: offered.subjectId, classGroupId: myClass.id };
      const existed = (await db(() => prisma.teachingAssignment.count({ where: combo }))) > 0;
      try {
        const okAssign = await postForm(staffPage, form, { subjectId: offered.subjectId, classGroupId: myClass.id }, cookie);
        check("control: an assignment of this school's own staff, subject and class is accepted", (await db(() => prisma.teachingAssignment.count({ where: combo }))) === 1, alerts(okAssign.html)[0]);
        const results = [];
        for (const override of [
          { staffId: foreign.staff.id },
          { subjectId: foreign.subject.id },
          { classGroupId: foreign.classGroup.id },
        ]) {
          const forged = await refusal(staffPage, form, { subjectId: offered.subjectId, classGroupId: myClass.id, ...override });
          results.push(says(forged.html, "was not found"));
        }
        check("an assignment naming another school's staff, subject or class is refused", results.every(Boolean), results.map((r) => (r ? "refused" : "ACCEPTED")).join(", "));
        check(
          "and none was written against them",
          (await db(() => prisma.teachingAssignment.count({ where: { OR: [{ staffId: foreign.staff.id }, { subjectId: foreign.subject.id }, { classGroupId: foreign.classGroup.id }] } }))) === 0,
        );
      } finally {
        if (!existed) await db(() => prisma.teachingAssignment.deleteMany({ where: combo }));
      }
    }
  }
}

async function main() {
  try {
    const probe = await fetch(BASE, { redirect: "manual" }).catch(() => null);
    if (!probe) {
      console.error(
        `Cannot reach ${BASE} — ${BASE.includes("localhost") ? "start the app with `npm run dev` first." : "is the deployment up?"}`,
      );
      process.exitCode = 1;
      return;
    }

    const { token, userId, schoolId } = await openSession();
    try {
      console.log(`Driving ${BASE}${usingForm ? ` as ${EMAIL}` : " as the demo proprietor"}.`);
      await deploymentChecks(token);
      await gradingGuards(token, schoolId);
      await accountGuards(token, userId);
      await studentGuards(token);
      await deleteGuards(token);
      await structureGuards(token);
      await feeGuards(token);
      await readOnlyGuards(token);
      await billChecks(token);
      await componentChecks(token);
      await importChecks(token);
      await foreignIdGuards(token);
    } finally {
      await closeSession(token);
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await prisma?.$disconnect();
  }
}

await main();

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
 * database as often as you like. If you add a case, keep that property — a
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
  return { token, userId: user.id };
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

async function gradingGuards(cookie) {
  console.log("\nGrading scales");
  if (!hasDb) {
    console.log("  --   no database access from here; these need fixtures to assert against");
    return;
  }
  const { html } = await fetchPage("/settings/grading", cookie);

  const frozen = await db(() => prisma.gradingScale.findFirst({
    where: { subjectResults: { some: {} } },
    select: { id: true, name: true, _count: { select: { subjectResults: true } } },
  }));
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
    where: { subjectResults: { none: {} }, bands: { some: {} } },
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

    const { token, userId } = await openSession();
    try {
      console.log(`Driving ${BASE}${usingForm ? ` as ${EMAIL}` : " as the demo proprietor"}.`);
      await deploymentChecks(token);
      await gradingGuards(token);
      await accountGuards(token, userId);
      await studentGuards(token);
      await deleteGuards(token);
      await structureGuards(token);
      await feeGuards(token);
      await readOnlyGuards(token);
      await billChecks(token);
      await componentChecks(token);
      await importChecks(token);
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

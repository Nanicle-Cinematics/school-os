/**
 * Walk a freshly provisioned school, screen by screen, as its proprietor.
 *
 * The bug class this hunts is the recurring one here: a screen that maps over an
 * empty collection looks merely empty but is actually a DEAD END — no control to
 * create the missing thing and no pointer at the screen that would. The demo
 * seed hides every one of them, because it creates everything.
 *
 * So this provisions a real school through `provisionSchool` — the same function
 * the console calls, not a re-implementation — signs in as the proprietor, and
 * prints what a head teacher on day one actually sees on each screen: the text,
 * the forms, the buttons, the links out.
 *
 *   npm run dev              # in another terminal
 *   npm run verify:onboarding
 *
 * It WRITES: one school, one proprietor and one platform admin, all named
 * `qa-<stamp>`. Point it at a development database only. Pass --clean <slug> to
 * delete a school a previous run left behind.
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma, type TenantTx } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { provisionSchool, PROVISION_TX_OPTS } from "@/lib/provisioning";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** This connection is as droppable as the app's; a P2024 here is noise. */
async function db<T>(op: () => Promise<T>, tries = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await op();
    } catch (error) {
      last = error;
      // The retry is here for dropped pooled connections, but it also hides a
      // real failure behind seven identical follow-ups — set QA_DEBUG to see the
      // first one, which is the only one that says anything.
      if (process.env.QA_DEBUG) {
        console.error(`  attempt ${i + 1} failed:`, (error as Error).message.split("\n")[0]);
      }
      await sleep(400 * (i + 1));
    }
  }
  throw last;
}

type Page = { status: number; location: string | null; html: string };

async function get(path: string, cookie: string, tries = 8): Promise<Page> {
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
  return { status: 500, location: null, html: "" };
}

/** Only the page's own body — the sidebar's links are not affordances of a screen. */
function main_(html: string) {
  return html.match(/<main\b[^>]*>([\s\S]*)<\/main>/)?.[1] ?? html;
}

function pageText(html: string) {
  return main_(html)
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function affordances(html: string) {
  const body = main_(html);
  const links = [...body.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => ({
      href: m[1],
      label: m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    }))
    .filter((l) => l.label);
  const buttons = [...body.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return {
    forms: (body.match(/<form\b/g) ?? []).length,
    inputs: (body.match(/<input\b/g) ?? []).length,
    selects: (body.match(/<select\b/g) ?? []).length,
    links,
    buttons,
  };
}

async function openSession(userId: string, activeSchoolId?: string) {
  const token = randomBytes(32).toString("hex");
  await db(() =>
    withBypass(() =>
      prisma.session.create({
        data: {
          userId,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          activeSchoolId,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
    ),
  );
  return token;
}

/** Every screen in the sidebar, plus the sub-screens each one leads to. */
/**
 * Routes that answer 404 ON PURPOSE for a school with no data: each needs query
 * parameters (a term, a class, an invoice) that a day-one school cannot supply.
 * Everything else must render.
 */
const DELIBERATE_404 = new Set(["/results/broadsheet", "/results/print", "/invoices/print"]);

const ROUTES = [
  "/dashboard",
  "/students",
  "/students/import",
  "/guardians",
  "/staff",
  "/houses",
  "/classes",
  "/subjects",
  "/assessments/sheet",
  "/assessments",
  "/results",
  "/results/broadsheet",
  "/results/remarks",
  "/results/print",
  "/promotions",
  "/fees",
  "/invoices",
  "/invoices/print",
  "/payments",
  "/expenses",
  "/messages",
  "/users",
  "/settings",
  "/settings/structure",
  "/settings/terms",
  "/settings/grading",
  "/settings/components",
];

async function clean(slug: string) {
  const school = await db(() =>
    withBypass(() => prisma.school.findUnique({ where: { slug } })),
  );
  if (!school) {
    console.log(`no school with slug ${slug}`);
    return;
  }
  await db(() => withBypass(() => prisma.school.delete({ where: { id: school.id } })));

  // The school's cascade takes the memberships but NOT the logins: User.schoolId
  // is SetNull, so the proprietor survives as an orphan with no school and no
  // membership, and a later run of this script would then collide on the email.
  const stamp = slug.replace(/^qa-/, "");
  const users = await db(() =>
    withBypass(() =>
      prisma.user.deleteMany({
        where: { email: { in: [`qa-${stamp}@example.com`, `qa-admin-${stamp}@example.com`] } },
      }),
    ),
  );
  console.log(`deleted ${school.name} and ${users.count} login(s)`);
}

async function main() {
  const cleanIndex = process.argv.indexOf("--clean");
  if (cleanIndex !== -1) {
    await clean(process.argv[cleanIndex + 1]);
    return;
  }

  const stamp = Date.now().toString(36);
  const slug = `qa-${stamp}`;
  const ownerEmail = `qa-${stamp}@example.com`;

  // The console is reached by session cookie, so this admin's password hash is
  // never exercised.
  const admin = await db(() =>
    withBypass(() =>
      prisma.user.create({
        data: {
          name: "QA Platform Admin",
          email: `qa-admin-${stamp}@example.com`,
          passwordHash: randomBytes(32).toString("hex"),
          isPlatformAdmin: true,
        },
      }),
    ),
  );

  const startedAt = Date.now();
  const { school, owner } = await db(() =>
    withBypass(() =>
      prisma.$transaction(
        (tx: TenantTx) =>
          provisionSchool(tx, {
            name: `QA Walkthrough School ${stamp}`,
            slug,
            shortName: "QA",
            plan: "TRIAL",
            classScoreWeight: 50,
            ownerName: "QA Proprietor",
            ownerEmail,
            passwordHash: randomBytes(32).toString("hex"),
            actorUserId: admin.id,
          }),
        PROVISION_TX_OPTS,
      ),
    ),
  );

  const provisionMs = Date.now() - startedAt;

  const counts = await db(() =>
    withBypass(async () => ({
      levels: await prisma.level.count({ where: { schoolId: school.id } }),
      subjects: await prisma.subject.count({ where: { schoolId: school.id } }),
      offerings: await prisma.levelSubject.count({ where: { schoolId: school.id } }),
      classGroups: await prisma.classGroup.count({ where: { schoolId: school.id } }),
      academicYears: await prisma.academicYear.count({ where: { schoolId: school.id } }),
      terms: await prisma.term.count({ where: { schoolId: school.id } }),
      houses: await prisma.house.count({ where: { schoolId: school.id } }),
      students: await prisma.student.count({ where: { schoolId: school.id } }),
      feeCategories: await prisma.feeCategory.count({ where: { schoolId: school.id } }),
      expenseCategories: await prisma.expenseCategory.count({ where: { schoolId: school.id } }),
      assessmentTemplates: await prisma.assessmentTemplate.count({ where: { schoolId: school.id } }),
      gradeBands: await prisma.gradeBand.count({ where: { schoolId: school.id } }),
      // A receipt is found by NAME: no template meant no text and no complaint.
      messageTemplates: await prisma.messageTemplate.count({ where: { schoolId: school.id } }),
    })),
  );

  console.log(`\nProvisioned ${school.name} (${slug}) in ${(provisionMs / 1000).toFixed(1)}s — proprietor ${ownerEmail}`);
  console.log(`A day-one school contains: ${JSON.stringify(counts, null, 0)}\n`);

  /**
   * Take the proprietor past the change-password wall before walking.
   *
   * `provisionSchool` gives a school's first login a TEMPORARY password, and
   * both layouts divert a flagged session to /account/password — so every route
   * below answered `307 -> /account/password` and this walk silently stopped
   * inspecting anything at all. It still reported, screen by screen, in the
   * shape of a healthy run: a title, no forms, no buttons, which is exactly what
   * an onboarding dead end looks like. The redirect is correct behaviour and is
   * covered by verify:parent; what this script is for is what a school SEES.
   */
  await db(() =>
    withBypass(() =>
      prisma.user.update({ where: { id: owner.id }, data: { mustChangePassword: false } }),
    ),
  );

  const token = await openSession(owner.id, school.id);

  /**
   * ⚠️ This walk PRINTED for months and asserted nothing, so a human had to read
   * 27 screens to notice a problem — and did not. When provisioning began issuing
   * the first proprietor a temporary password, every route answered
   * `307 -> /account/password` and the report went on looking healthy: a title,
   * no forms, no buttons, screen after screen, which is indistinguishable from
   * the onboarding dead ends this script exists to find.
   *
   * So it now fails. A redirect is the loudest of these: it means the walk never
   * reached the screen it is reporting on.
   */
  const problems: string[] = [];

  for (const route of ROUTES) {
    const page = await get(route, token);
    const text = pageText(page.html);
    const a = affordances(page.html);
    const redirect = page.location ? ` -> ${page.location}` : "";
    console.log(`\n──── ${route}  [${page.status}${redirect}]${page.status !== 200 ? "  <<< NON-200" : ""}`);

    if (page.location) {
      problems.push(`${route} redirected to ${page.location} — the screen was never reached`);
    } else if (DELIBERATE_404.has(route)) {
      if (page.status !== 404) {
        problems.push(`${route} answered ${page.status}; it needs query parameters and should 404`);
      }
    } else if (page.status !== 200) {
      problems.push(`${route} answered ${page.status}`);
    } else if (!text.trim()) {
      problems.push(`${route} rendered no text at all`);
    } else if (route === "/dashboard" && text.includes("Nothing is waiting on you")) {
      /**
       * ⚠️ A card can be worse than empty: it can be wrong. Every rule behind
       * "Needs your attention" counts something a NEW school does not have yet,
       * so all four stayed silent and a school with no calendar, no classes and
       * no pupils was told nothing was waiting on it — on the first screen it
       * ever sees. A screen offering nothing to click is caught above; this
       * catches a screen that offers reassurance instead.
       */
      problems.push(
        "/dashboard tells a school with nothing set up that nothing is waiting on it",
      );
    } else if (a.forms + a.buttons.length + a.links.length === 0) {
      // A screen with nothing to press is either broken or a dead end, and this
      // script cannot tell the difference — which is reason enough to look.
      problems.push(`${route} offers nothing at all: no form, no button, no link`);
    }
    console.log(`  text : ${text.slice(0, 460)}`);
    console.log(`  ctrl : forms=${a.forms} inputs=${a.inputs} selects=${a.selects}`);
    console.log(`  btns : ${a.buttons.slice(0, 8).join(" | ") || "—"}`);
    console.log(`  links: ${a.links.slice(0, 10).map((l) => `${l.label}→${l.href}`).join(" | ") || "—"}`);
  }

  console.log(`\n\nLeft behind: school ${slug}, admin qa-admin-${stamp}@example.com`);
  console.log(`Remove with: npm run verify:onboarding -- --clean ${slug}`);

  if (problems.length > 0) {
    console.log(`\n${problems.length} PROBLEM${problems.length === 1 ? "" : "S"}:`);
    for (const problem of problems) {
      console.log(`  FAIL ${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`\nAll ${ROUTES.length} screens render for a day-one school.`);
}

main()
  .catch((error) => {
    console.error("FATAL", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

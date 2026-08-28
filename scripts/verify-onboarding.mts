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
  console.log(`deleted ${school.name}`);
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
    })),
  );

  console.log(`\nProvisioned ${school.name} (${slug}) in ${(provisionMs / 1000).toFixed(1)}s — proprietor ${ownerEmail}`);
  console.log(`A day-one school contains: ${JSON.stringify(counts, null, 0)}\n`);

  const token = await openSession(owner.id, school.id);

  for (const route of ROUTES) {
    const page = await get(route, token);
    const text = pageText(page.html);
    const a = affordances(page.html);
    const redirect = page.location ? ` -> ${page.location}` : "";
    console.log(`\n──── ${route}  [${page.status}${redirect}]${page.status !== 200 ? "  <<< NON-200" : ""}`);
    console.log(`  text : ${text.slice(0, 460)}`);
    console.log(`  ctrl : forms=${a.forms} inputs=${a.inputs} selects=${a.selects}`);
    console.log(`  btns : ${a.buttons.slice(0, 8).join(" | ") || "—"}`);
    console.log(`  links: ${a.links.slice(0, 10).map((l) => `${l.label}→${l.href}`).join(" | ") || "—"}`);
  }

  console.log(`\n\nLeft behind: school ${slug}, admin qa-admin-${stamp}@example.com`);
  console.log(`Remove with: npm run verify:onboarding -- --clean ${slug}`);
}

main()
  .catch((error) => {
    console.error("FATAL", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

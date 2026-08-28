/**
 * Prove a class teacher can reach the report-card entry screens and nothing else.
 *
 * The point is not that the nav hides the other links — a hidden link is not a
 * guard. This signs in as a teacher and asks for every route in the app by URL,
 * the way someone pasting a bookmark would, and asserts each one either serves
 * the marking screens or redirects away.
 *
 *   npm run dev
 *   npm run verify:teacher
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { landingFor, isTeacherOnly } from "@/lib/permissions";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";
const LANDING = "/assessments/sheet";

/** The two screens a teacher signs in to use. */
const ALLOWED = ["/assessments/sheet", "/results/remarks"];

/** Everything else reachable from the sidebar or by typing a URL. */
const FORBIDDEN = [
  "/dashboard",
  "/students",
  "/students/import",
  "/guardians",
  "/staff",
  "/houses",
  "/classes",
  "/subjects",
  "/assessments",
  "/results",
  "/results/broadsheet",
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
  check("the sidebar offers only the two marking screens", extra.length === 0,
    extra.length ? `also offers ${extra.join(", ")}` : links.join(", "));

  await withBypass(() =>
    prisma.session.deleteMany({
      where: { tokenHash: createHash("sha256").update(token).digest("hex") },
    }),
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("FATAL", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

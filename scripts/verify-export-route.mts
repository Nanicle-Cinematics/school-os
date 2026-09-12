/**
 * The download itself, through HTTP, against a running dev server.
 *
 * `verify:export` exercises the loaders and the CSV writer. It cannot see the
 * things that only exist on the route: the role refusal, the tenant context,
 * the headers that make a browser save a file, and the audit row. Those are
 * exactly the parts that fail quietly — a forgotten `setTenantContext` returns
 * a file with a header and no rows, which reads as "the school has no
 * students", and a missing role check hands a teacher the whole register.
 *
 *   npm run dev
 *   npm run verify:export:route
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { DATASET_NAMES, dataset } from "@/lib/export-data";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(path: string, token: string, tries = 8) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await fetch(BASE + path, {
        headers: { Cookie: `${COOKIE}=${token}` },
        redirect: "manual",
      });
      // Retry a 500 a few times — a cold dev server compiles the route on the
      // first hit — but REPORT a persistent one rather than throwing. A crash
      // here loses which check failed, and "the export 500s" is itself an
      // answer worth printing.
      if (response.status === 500 && i < tries - 1) {
        await sleep(500 * (i + 1));
        continue;
      }
      return {
        status: response.status,
        disposition: response.headers.get("content-disposition"),
        type: response.headers.get("content-type"),
        cache: response.headers.get("cache-control"),
        body: await response.text(),
      };
    } catch {
      await sleep(500 * (i + 1));
    }
  }
  throw new Error(`GET ${path} never answered`);
}

/** A session for the first membership with this role, and the school it is in. */
async function signIn(role: "OWNER" | "TEACHER" | "ACCOUNTANT") {
  const membership = await withBypass(() =>
    prisma.membership.findFirst({
      where: { role, status: "ACTIVE" },
      include: { user: { select: { id: true, name: true } } },
    }),
  );
  if (!membership) {
    return null;
  }
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
  return { token, membership };
}

// Everything after this instant is ours, which is how the audit check below
// tells this run's rows from the ones already in the log.
const startedAt = new Date();

const owner = await signIn("OWNER");
if (!owner) {
  throw new Error("no OWNER membership in this database");
}
console.log(`Signed in as ${owner.membership.user.name}\n`);

const term = await withBypass(() =>
  prisma.term.findFirst({
    where: { schoolId: owner.membership.schoolId, isCurrent: true },
    select: { id: true },
  }),
);

console.log("The owner can take every file");
for (const name of DATASET_NAMES) {
  const spec = dataset(name);
  const path = spec.needsTerm
    ? `/api/export/${name}?term=${term?.id ?? ""}`
    : `/api/export/${name}`;
  const response = await get(path, owner.token);

  check(`${name}: 200`, response.status === 200, `status ${response.status}`);
  check(
    `${name}: arrives as a file`,
    (response.disposition ?? "").startsWith("attachment;") &&
      (response.disposition ?? "").includes(".csv"),
    response.disposition ?? "no Content-Disposition",
  );
  check(
    `${name}: is CSV`,
    (response.type ?? "").startsWith("text/csv"),
    response.type ?? "no Content-Type",
  );
  check(
    `${name}: is never cached`,
    (response.cache ?? "").includes("no-store"),
    response.cache ?? "no Cache-Control",
  );

  /**
   * ⚠️ And that it has CONTENT. Under RLS a query with no tenant context
   * returns nothing rather than failing, so the way this route breaks is a
   * perfectly valid CSV with a header row and nothing underneath.
   */
  const lines = response.body.trim().split("\r\n");
  check(
    `${name}: has rows, not just a header`,
    lines.length > 1,
    `${lines.length - 1} data rows`,
  );
  check(
    `${name}: the header is the one it promised`,
    lines[0]?.replace(/^﻿/, "").split(",").length === spec.headers.length,
    lines[0]?.slice(0, 60),
  );
}

console.log("\nAnd a teacher can take none of it");
const teacher = await signIn("TEACHER");
if (teacher) {
  for (const name of DATASET_NAMES) {
    const spec = dataset(name);
    const path = spec.needsTerm
      ? `/api/export/${name}?term=${term?.id ?? ""}`
      : `/api/export/${name}`;
    const response = await get(path, teacher.token);
    check(
      `${name} is refused`,
      response.status === 403,
      response.status === 200 ? "200 — HANDED OVER" : `status ${response.status}`,
    );
  }
} else {
  check("a teacher fixture exists to refuse", false, "no TEACHER membership seeded");
}

console.log("\nAn accountant gets the money and not the children");
const accountant = await signIn("ACCOUNTANT");
if (accountant) {
  check(
    "invoices: 200",
    (await get(`/api/export/invoices?term=${term?.id ?? ""}`, accountant.token)).status === 200,
  );
  check(
    "students: 403",
    (await get("/api/export/students", accountant.token)).status === 403,
  );
}

console.log("\nRefusals that are not about roles");
check(
  "an unknown dataset is a 404",
  (await get("/api/export/salaries", owner.token)).status === 404,
);
check(
  "a term-scoped export with no term is a 400, not an empty file",
  (await get("/api/export/results", owner.token)).status === 400,
);
check(
  "a term id that is not this school's reads as missing",
  (await get("/api/export/results?term=not-a-real-term", owner.token)).status === 404,
);
check(
  "signed out, nothing comes back as a CSV",
  !((await get("/api/export/students", "not-a-session")).type ?? "").startsWith("text/csv"),
);

console.log("\nEvery export is written down");

/**
 * ⚠️ Only the rows THIS run wrote.
 *
 * Counting every `data.export` row was a check that could never fail again: the
 * dev log had 28 of them from earlier runs, so removing the audit call
 * altogether still passed. A guard whose green state is its never-fires state
 * is not a guard — see CLAUDE.md.
 */
const audits = await withBypass(() =>
  prisma.auditLog.findMany({
    where: {
      action: "data.export",
      schoolId: owner.membership.schoolId,
      createdAt: { gte: startedAt },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  }),
);
check(
  "this run's downloads are all in the audit trail",
  audits.length >= DATASET_NAMES.length,
  `${audits.length} entries since the run began, for ${DATASET_NAMES.length} datasets`,
);
check(
  "each names what was taken and how much",
  audits.slice(0, 3).every((row) => {
    const after = row.after as { dataset?: string; rows?: number } | null;
    return Boolean(after?.dataset) && typeof after?.rows === "number";
  }),
  JSON.stringify(audits[0]?.after),
);
/**
 * Every entry names SOMEBODY, and the owner is among them.
 *
 * Not "the last three were the owner": the accountant downloaded invoices after
 * them, so the newest rows are legitimately someone else's — which is the
 * feature working. An entry with a null actor would be the real failure, since
 * an audit trail that cannot say who took the register is not an audit trail.
 */
check(
  "no export is recorded without an actor",
  audits.every((row) => row.actorUserId !== null),
  `${audits.filter((row) => row.actorUserId === null).length} anonymous`,
);
check(
  "and the owner's own downloads name the owner",
  audits.some((row) => row.actorUserId === owner.membership.userId),
);
check(
  "the accountant's download is attributed to the accountant, not the owner",
  !accountant ||
    audits.some(
      (row) =>
        row.actorUserId === accountant.membership.userId &&
        (row.after as { dataset?: string } | null)?.dataset === "invoices",
    ),
);

// Tidy up: the sessions this script created, and nothing else.
await withBypass(() =>
  prisma.session.deleteMany({
    where: {
      tokenHash: {
        in: [owner, teacher, accountant]
          .filter((s): s is NonNullable<typeof s> => s !== null)
          .map((s) => createHash("sha256").update(s.token).digest("hex")),
      },
    },
  }),
);

console.log(`\n${passed} passed, ${failed} failed`);
await prisma.$disconnect();
process.exit(failed === 0 ? 0 : 1);

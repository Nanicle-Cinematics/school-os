/**
 * The pasted SQL does exactly what the connected command does.
 *
 * `sql-delete-school` prints SQL for a database this machine cannot reach, so
 * nothing about it is checked by running it against production — by then it is
 * too late. This builds the same situation on DEV, runs the GENERATED text
 * (captured from the command's own stdout, never retyped), and looks at what
 * survived.
 *
 * The bystanders are the point. The connected version's first draft swept every
 * orphan in the database instead of this school's own, and only a deliberate
 * unrelated account proved it. So this plants four accounts that must live
 * through the delete and two that must not.
 *
 *   npm run verify:platform:sql   (no dev server needed)
 */
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";

/**
 * The generated SQL runs through a SECOND, unextended client on the owner
 * connection — because that is who the Supabase SQL editor is.
 *
 * `prisma` connects as the restricted role, which owns nothing and bypasses
 * nothing, and its extension sets the tenant GUCs around model calls but not
 * around raw ones. Running the paste-this SQL through it tests row security
 * this SQL will never meet, and the first run of this file duly reported the
 * preview finding no school — on a school that was plainly there.
 */
const editor = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

const TARGET = "zzz-sql-target";
const OTHER = "zzz-sql-other";
const DOMAIN = "@zzz-sql.test";

/** Pull one numbered block out of what the command printed. */
function block(output: string, from: string, to: string) {
  const start = output.indexOf(from);
  const end = output.indexOf(to);
  if (start < 0 || end < 0) throw new Error(`could not find the ${from} block in the output`);
  return output.slice(output.indexOf("\n", start) + 1, end).trim();
}

async function reset() {
  await withBypass(async () => {
    await prisma.school.deleteMany({ where: { slug: { in: [TARGET, OTHER] } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  });
}

async function build() {
  const target = await withBypass(() =>
    prisma.school.create({ data: { name: "SQL Target Academy", slug: TARGET } }),
  );
  const other = await withBypass(() =>
    prisma.school.create({ data: { name: "SQL Other Academy", slug: OTHER } }),
  );

  await withBypass(() =>
    prisma.student.create({
      data: {
        schoolId: target.id,
        admissionNo: "SQL/001",
        firstName: "Cascade",
        lastName: "Test",
        gender: "MALE",
      },
    }),
  );

  // Must go: the proprietor (home school + membership) and a teacher (membership
  // only — the shape a staff login actually has).
  await withBypass(() =>
    prisma.user.create({
      data: {
        email: `owner${DOMAIN}`,
        name: "Owner",
        schoolId: target.id,
        memberships: { create: { schoolId: target.id, role: "OWNER" } },
      },
    }),
  );
  await withBypass(() =>
    prisma.user.create({
      data: {
        email: `teacher${DOMAIN}`,
        name: "Teacher",
        memberships: { create: { schoolId: target.id, role: "TEACHER" } },
      },
    }),
  );

  // Must stay: works at both schools, so the cascade leaves them a membership.
  await withBypass(() =>
    prisma.user.create({
      data: {
        email: `shared${DOMAIN}`,
        name: "Shared",
        schoolId: target.id,
        memberships: {
          create: [
            { schoolId: target.id, role: "TEACHER" },
            { schoolId: other.id, role: "TEACHER" },
          ],
        },
      },
    }),
  );
  // Must stay: somebody else's school entirely.
  await withBypass(() =>
    prisma.user.create({
      data: {
        email: `neighbour${DOMAIN}`,
        name: "Neighbour",
        schoolId: other.id,
        memberships: { create: { schoolId: other.id, role: "OWNER" } },
      },
    }),
  );
  // Must stay: an orphan already in the database, belonging to nobody in this
  // operation. This is the account the first draft of the sweep deleted.
  await withBypass(() =>
    prisma.user.create({ data: { email: `bystander${DOMAIN}`, name: "Bystander" } }),
  );
  // Must stay: the way back in.
  await withBypass(() =>
    prisma.user.create({
      data: { email: `admin${DOMAIN}`, name: "Admin", schoolId: target.id, isPlatformAdmin: true },
    }),
  );
}

const generated = execFileSync(
  "npx",
  ["tsx", "--env-file=.env", "scripts/platform.mts", "sql-delete-school", TARGET],
  { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" } },
);

await reset();
await build();

console.log("\nThe preview says what the delete will do");
const preview = block(generated, "── 1. What will go", "No row means");
const [seen] = await editor.$queryRawUnsafe<
  { name: string; students: bigint; memberships: bigint; logins_removed: string }[]
>(preview);
check("it finds the school", seen?.name === "SQL Target Academy", seen?.name);
check("it counts the students that will cascade", Number(seen?.students) === 1);
check("it counts the memberships that will cascade", Number(seen?.memberships) === 3);
check(
  "it names the logins that will go, and only those",
  seen?.logins_removed === `owner${DOMAIN}, teacher${DOMAIN}`,
  seen?.logins_removed,
);

console.log("\nRunning the generated SQL");
const remove = block(generated, "── 2. Delete it", "── 3. Confirm");
check("the block is a DO block, not a chained CTE", remove.startsWith("do $$"));
await editor.$executeRawUnsafe(remove);

console.log("\nWhat went");
const school = await withBypass(() => prisma.school.findUnique({ where: { slug: TARGET } }));
check("the school is gone", school === null);
const students = await withBypass(() =>
  prisma.student.count({ where: { admissionNo: "SQL/001" } }),
);
check("its rows cascaded", students === 0);

const survivors = await withBypass(() =>
  prisma.user.findMany({ where: { email: { endsWith: DOMAIN } }, select: { email: true } }),
);
const left = new Set(survivors.map((u) => u.email));
check("the proprietor's login is gone", !left.has(`owner${DOMAIN}`));
check("the teacher's login is gone", !left.has(`teacher${DOMAIN}`));

console.log("\nWhat stayed");
check("a teacher who also works elsewhere keeps their account", left.has(`shared${DOMAIN}`));
check("another school's proprietor is untouched", left.has(`neighbour${DOMAIN}`));
check("an unrelated orphan is untouched", left.has(`bystander${DOMAIN}`));
check("the platform admin is untouched", left.has(`admin${DOMAIN}`));
const otherSchool = await withBypass(() =>
  prisma.school.findUnique({ where: { slug: OTHER }, select: { _count: { select: { memberships: true } } } }),
);
check("the other school still has both its memberships", otherSchool?._count.memberships === 2);

console.log("\nThe confirmation query reports it");
const confirm = block(generated, "── 3. Confirm", "school_left must be 0");
const [after] = await editor.$queryRawUnsafe<
  { school_left: bigint; admins_remaining: bigint }[]
>(confirm);
check("school_left is 0", Number(after?.school_left) === 0);
check("at least one admin remains", Number(after?.admins_remaining) >= 1);

console.log("\nRunning it again on a slug that is gone");
let raised = false;
try {
  await editor.$executeRawUnsafe(remove);
} catch (error) {
  raised = /No school with the slug/.test(String(error));
}
check("it refuses rather than deleting nothing quietly", raised);

await reset();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
await editor.$disconnect();
await prisma.$disconnect();

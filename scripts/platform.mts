/**
 * The two things you cannot do from inside the product.
 *
 * ⚠️ Deliberately a SCRIPT and not a screen. Both of these are powers the app
 * must never hand to a logged-in user: one mints a platform administrator, the
 * other destroys a tenant and everything in it. A console that could do either
 * is a console worth attacking. The only key is database access.
 *
 * Run it against whichever database the env file points at:
 *
 *   npm run platform -- admin you@example.com            # create or reset
 *   npm run platform -- delete-school st-mary-demo       # tenant + orphans
 *
 * Or, when the database password is lost rather than merely unused, the same
 * two things as SQL to paste into the Supabase editor — no connection at all:
 *
 *   npm run platform -- sql you@example.com
 *   npm run platform -- sql-delete-school st-mary-demo
 *
 * For PRODUCTION, put the connection string in `.env.prod` — covered by
 * .gitignore's `.env*`, and NOT a name Next auto-loads, unlike `.env.local`:
 *
 *   npm run platform:prod -- admin you@example.com
 *
 * ⚠️ `db.<ref>.supabase.co:5432` is IPv6-only and unreachable from this Mac.
 * Use the session pooler `aws-0-eu-central-1.pooler.supabase.com:5432`, where
 * the username is `postgres.<ref>` rather than plain `postgres`.
 */
import { createInterface } from "node:readline/promises";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { hashPassword, temporaryPassword } from "@/lib/password";

const [command, argument] = process.argv.slice(2).filter((a) => a !== "--");

/** Which database is about to be changed, in words, before anything happens. */
function target() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "";
  const host = /@([^/:]+)/.exec(url)?.[1] ?? "unknown host";
  const ref = /postgres\.([a-z0-9]+)/.exec(url)?.[1] ?? null;
  return ref ? `${host} (project ${ref})` : host;
}

async function confirm(question: string, expected: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question}\nType ${expected} to continue: `)).trim();
  rl.close();
  return answer === expected;
}

async function makeAdmin(email: string) {
  const existing = await withBypass(() =>
    prisma.user.findFirst({ where: { email, deletedAt: null } }),
  );
  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);

  if (existing) {
    await withBypass(() =>
      prisma.user.update({
        where: { id: existing.id },
        // ⚠️ mustChangePassword, always. A password that reached a terminal —
        // and therefore a scrollback buffer and possibly a screenshot — is a
        // way in for one login, not a credential.
        data: { isPlatformAdmin: true, passwordHash, mustChangePassword: true },
      }),
    );
    console.log(`\n${existing.name} <${email}> is a platform admin, with a new password.`);
  } else {
    await withBypass(() =>
      prisma.user.create({
        data: {
          email,
          name: email.split("@")[0],
          passwordHash,
          isPlatformAdmin: true,
          mustChangePassword: true,
        },
      }),
    );
    console.log(`\nCreated ${email} as a platform admin.`);
  }

  console.log(`Temporary password: ${password}`);
  console.log("It must be changed at the first sign-in.\n");
}

async function deleteSchool(slug: string) {
  const school = await withBypass(() =>
    prisma.school.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        _count: { select: { students: true, staff: true, memberships: true, invoices: true } },
      },
    }),
  );
  if (!school) {
    console.error(`No school with the slug ${slug}.`);
    process.exitCode = 1;
    return;
  }

  const counts = school._count;
  console.log(`\n${school.name} (${slug}) on ${target()}`);
  console.log(
    `  ${counts.students} students · ${counts.staff} staff · ${counts.memberships} memberships · ${counts.invoices} invoices`,
  );
  console.log("  Every row in all 40 tenant tables cascades. This cannot be undone.\n");

  if (!(await confirm("Delete it?", slug))) {
    console.log("Left alone.");
    return;
  }

  /**
   * ⚠️ Collect THIS school's logins BEFORE the delete, not after.
   *
   * The cascade takes memberships but NOT logins: `User.schoolId` is SetNull,
   * so a proprietor survives as an orphan with no school and no membership — a
   * row that can still sign in and lands on /no-access. Clearing them is the
   * difference between deleting a tenant and leaving its ghosts behind.
   *
   * The first version swept every orphan in the DATABASE instead, and testing
   * on a throwaway school proved it: one login created, two deleted. The second
   * belonged to nobody in this operation. On a production database that is
   * somebody else's account gone, in a command that had no business touching it.
   */
  const belonged = await withBypass(() =>
    prisma.user.findMany({
      where: {
        OR: [{ schoolId: school.id }, { memberships: { some: { schoolId: school.id } } }],
        isPlatformAdmin: false,
      },
      select: { id: true },
    }),
  );

  await withBypass(() => prisma.school.delete({ where: { id: school.id } }));

  const orphans = await withBypass(() =>
    prisma.user.deleteMany({
      // Only the ones this school owned, and only if the cascade left them with
      // nothing — a member of staff who also works at another school stays.
      where: {
        id: { in: belonged.map((u) => u.id) },
        schoolId: null,
        memberships: { none: {} },
      },
    }),
  );
  console.log(`\nDeleted ${school.name} and ${orphans.count} orphaned login(s).\n`);
}

/**
 * The same account, without needing the database password.
 *
 * ⚠️ Supabase will not SHOW an existing database password — it only offers to
 * reset one, and resetting it breaks production until Vercel's environment
 * variables are updated and the app redeployed. So when the password is lost
 * rather than merely unused, `admin` cannot run at all.
 *
 * This path needs no connection: it hashes the password here and prints the one
 * statement to paste into the Supabase SQL editor, which is authenticated by
 * the dashboard session rather than by the database password. The password
 * itself never leaves this machine — only its scrypt hash does, and a hash in a
 * SQL editor is not a credential.
 */
async function printSql(email: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = (await rl.question("Choose a password for this account: ")).trim();
  rl.close();

  if (password.length < 8) {
    console.error("\nUse at least 8 characters.");
    process.exitCode = 1;
    return;
  }

  const hash = await hashPassword(password);
  console.log(`
Paste this into the Supabase SQL editor for the PRODUCTION project.
It promotes the account if it exists, and creates it if it does not.

──────────────────────────────────────────────────────────────────────
insert into "User" (id, email, name, "passwordHash", "isPlatformAdmin",
                    "mustChangePassword", "createdAt", "updatedAt")
values (gen_random_uuid()::text, '${email}', '${email.split("@")[0]}',
        '${hash}', true, false, now(), now())
on conflict (email) do update
  set "passwordHash"      = excluded."passwordHash",
      "isPlatformAdmin"   = true,
      "mustChangePassword" = false,
      "updatedAt"          = now();
──────────────────────────────────────────────────────────────────────

Then sign in at /login with ${email} and the password you just typed.
`);
}

/**
 * The same deletion, without needing the database password.
 *
 * Everything `deleteSchool` does, written out as SQL to paste into the Supabase
 * editor — which is authenticated by the dashboard session, not by the database
 * password. Three parts, in order: see what will go, delete it, confirm it went.
 *
 * ⚠️ A single statement CANNOT do this. Data-modifying CTEs all read the same
 * snapshot, so a `delete from "User"` chained onto the school delete would still
 * see the proprietor's `schoolId` pointing at the school and their memberships
 * present — the SetNull and the cascade are invisible to it — and would quietly
 * remove nobody. The DO block runs its statements in sequence, each seeing the
 * last one's effects, which is the only shape that works.
 */
function printDeleteSql(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error(`\n"${slug}" is not a slug. Expected lowercase letters, digits and hyphens.`);
    process.exitCode = 1;
    return;
  }

  console.log(`
Paste these into the Supabase SQL editor, one at a time, in order.

── 1. What will go ───────────────────────────────────────────────────
select s.name,
       (select count(*) from "Student"    t where t."schoolId" = s.id) as students,
       (select count(*) from "Staff"      t where t."schoolId" = s.id) as staff,
       (select count(*) from "Membership" t where t."schoolId" = s.id) as memberships,
       (select count(*) from "Invoice"    t where t."schoolId" = s.id) as invoices,
       (select coalesce(string_agg(u.email, ', '), 'none')
          from "User" u
         where u."isPlatformAdmin" = false
           and (u."schoolId" = s.id
                or exists (select 1 from "Membership" m
                            where m."userId" = u.id and m."schoolId" = s.id))
           and (u."schoolId" = s.id or u."schoolId" is null)
           and not exists (select 1 from "Membership" m
                            where m."userId" = u.id and m."schoolId" <> s.id))
                                                                       as logins_removed
  from "School" s
 where s.slug = '${slug}';

No row means no school with that slug — stop, and check the slug.

── 2. Delete it ──────────────────────────────────────────────────────
do $$
declare
  target   text;
  belonged text[];
  removed  int;
begin
  perform set_config('app.bypass_rls', 'on', true);

  select id into target from "School" where slug = '${slug}';
  if target is null then
    raise exception 'No school with the slug %', '${slug}';
  end if;

  -- Collect this school's logins BEFORE the delete. "User"."schoolId" is
  -- SET NULL, so once the school is gone nothing records who belonged to it.
  select coalesce(array_agg(u.id), '{}') into belonged
    from "User" u
   where u."isPlatformAdmin" = false
     and (u."schoolId" = target
          or exists (select 1 from "Membership" m
                      where m."userId" = u.id and m."schoolId" = target));

  delete from "School" where id = target;   -- 40 tenant tables cascade

  -- Only this school's own logins, and only those the cascade left with
  -- nothing: a member of staff who also works elsewhere keeps their account.
  delete from "User" u
   where u.id = any(belonged)
     and u."schoolId" is null
     and not exists (select 1 from "Membership" m where m."userId" = u.id);
  get diagnostics removed = row_count;

  raise notice 'Deleted the school and % orphaned login(s).', removed;
end $$;

── 3. Confirm ────────────────────────────────────────────────────────
select (select count(*) from "School" where slug = '${slug}') as school_left,
       (select count(*) from "School")                        as schools_remaining,
       (select count(*) from "User" where "isPlatformAdmin")  as admins_remaining;

school_left must be 0, and admins_remaining must still be at least 1 —
that second number is your own way back in.
──────────────────────────────────────────────────────────────────────
`);
}

if (command === "sql" && argument) {
  await printSql(argument.trim().toLowerCase());
} else if (command === "sql-delete-school" && argument) {
  printDeleteSql(argument.trim());
} else if (command === "admin" && argument) {
  console.log(`\nDatabase: ${target()}`);
  await makeAdmin(argument.trim().toLowerCase());
} else if (command === "delete-school" && argument) {
  await deleteSchool(argument.trim());
} else {
  console.error(
    "Usage:\n" +
      "  npm run platform -- sql <email>                  # no DB password needed\n" +
      "  npm run platform -- sql-delete-school <slug>     # no DB password needed\n" +
      "  npm run platform -- admin <email>\n" +
      "  npm run platform -- delete-school <slug>",
  );
  process.exitCode = 1;
}

await prisma.$disconnect();

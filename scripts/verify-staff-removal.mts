/**
 * Who may be removed from the staff list is decided when Remove is pressed, not on every view of the page.
 *
 *   npm run verify:staff-removal
 *
 * A member of staff who has entered marks (a mark sheet has to keep naming who entered it) or who form-teaches a class
 * cannot be removed. The page used to learn the first by counting every school's scores to put a hint under the
 * button (about 100 ms at ten schools, growing with the data); the action already refused on its own. The page no
 * longer counts, and the action asks `staffRemovalBlockers`: an existence check scoped to the school.
 *
 * Checks the rule against the original two counts for EVERY member of staff, plants each blocker inside a transaction
 * that is rolled back (the seeded school has no scores with an enterer, so without that the "has entered marks" answer
 * would be false for everyone and the comparison would prove nothing), and reads the source to confirm the page
 * stopped counting and the action uses the one rule.
 *
 * Development databases only, like every guard that reads the seed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";
import { staffRemovalBlockers } from "@/lib/staff-data";
import { demoSchool } from "./fixture.mjs";

const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  if (!ok) failures += 1;
}
class Rollback extends Error {}

const school = await demoSchool();
const root = resolve(import.meta.dirname, "..");
const code = (file: string) => readFileSync(resolve(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

console.log("The rule equals the two counts it replaces, for every member of staff");
try {
  await db.$transaction(
    async (tx) => {
      const asTx = tx as unknown as TenantTx;
      const staff = await tx.staff.findMany({ where: { schoolId: school.id }, select: { id: true, firstName: true } });
      const scores = await tx.score.findMany({ where: { schoolId: school.id }, take: 3, select: { id: true } });
      const classes = await tx.classGroup.findMany({ where: { schoolId: school.id }, take: 3, select: { id: true } });
      check(`${staff.length} staff, ${scores.length} scores and ${classes.length} classes to work with`, staff.length >= 4 && scores.length >= 1 && classes.length >= 1);

      const compare = async (label: string) => {
        const wrong: string[] = [];
        for (const member of staff) {
          const want = {
            enteredScores: (await tx.score.count({ where: { enteredByStaffId: member.id } })) > 0,
            formClasses: (await tx.classGroup.count({ where: { formTeacherId: member.id } })) > 0,
          };
          const got = await staffRemovalBlockers(school.id, member.id, asTx);
          if (got.enteredScores !== want.enteredScores || got.formClasses !== want.formClasses) wrong.push(`${member.firstName}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
        }
        check(`${label}: every member of staff gets the answer the counts gave`, wrong.length === 0, wrong.join("; "));
      };

      await compare("as seeded");

      // Plant each blocker on a DIFFERENT, freshly made person, so a rule that mixes them up shows (a seeded member of
      // staff may already form-teach a class, which would make "someone with neither" a guess).
      const person = (suffix: string) =>
        tx.staff.create({ data: { schoolId: school.id, staffNo: `VSR-${suffix}`, firstName: "Probe", lastName: suffix, gender: "FEMALE" } });
      const marker = await person("MARKER");
      const teacher = await person("TEACHER");
      const bystander = await person("NEITHER");
      staff.push({ id: marker.id, firstName: "marker" }, { id: teacher.id, firstName: "teacher" }, { id: bystander.id, firstName: "bystander" });
      await tx.score.update({ where: { id: scores[0]!.id }, data: { enteredByStaffId: marker.id } });
      await tx.classGroup.update({ where: { id: classes[0]!.id }, data: { formTeacherId: teacher.id } });
      await compare("with a mark entered by one person and a class form-taught by another");

      const m = await staffRemovalBlockers(school.id, marker.id, asTx);
      const t = await staffRemovalBlockers(school.id, teacher.id, asTx);
      const b = await staffRemovalBlockers(school.id, bystander.id, asTx);
      check("the one who entered a mark is blocked for that, and not as a form teacher", m.enteredScores === true && m.formClasses === false);
      check("the form teacher is blocked as one, and has entered nothing", t.formClasses === true && t.enteredScores === false);
      check("someone with neither is not blocked", b.enteredScores === false && b.formClasses === false);
      check("an unknown id is blocked by nothing", JSON.stringify(await staffRemovalBlockers(school.id, "no-such-staff", asTx)) === JSON.stringify({ enteredScores: false, formClasses: false }));
      throw new Rollback();
    },
    { timeout: 300_000, maxWait: 30_000 },
  );
} catch (error) {
  if (!(error instanceof Rollback)) {
    console.error(error);
    failures += 1;
  }
}

console.log("\nWiring");
const page = code("src/app/(app)/staff/[id]/page.tsx");
const data = code("src/lib/staff-data.ts");
const action = code("src/lib/staff-actions.ts");
check("the page no longer counts a member's scores on every view", !/enteredScores/.test(page) && !/enteredScores:\s*true/.test(data.replace(/staffRemovalBlockers[\s\S]*$/, "")));
check("removeStaff asks the one rule when Remove is pressed", /staffRemovalBlockers\(auth\.schoolId, id\)/.test(action));
check("and still refuses with the same in-use banner", /redirect\(`\/staff\/\$\{id\}\?error=in-use`\)/.test(action));
check("the rule is scoped to the school (the index the existence check relies on)", /score\.findFirst\(\{ where: \{ schoolId, enteredByStaffId/.test(data));

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);

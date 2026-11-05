/**
 * The library, against the real app and database.
 *
 *   npm run verify:library-route        (needs the app running)
 *
 * `verify:library` proves the rules and the shape of the code. This proves them where it matters:
 *
 *   - a title is made with numbered copies; a typed `123` finds `ACC-00123`; a copy goes out to ONE person, a pupil is held
 *     to the limit, an overdue book stops the next loan (and only while the rule says so), and a returned book comes back once;
 *   - renewing works twice and then not, and not once late; lost and withdrawn copies cannot be lent, and a lost book that is
 *     out is closed against the borrower; a copy or title with a history cannot be deleted;
 *   - two desks lending the same copy at the same instant make ONE loan, and one pupil cannot be pushed past the limit by
 *     three desks at once (forced red by taking the locks out: see the notes in CLAUDE.md);
 *   - routine lending is not audited; losing a copy is, and the audit row carries no name or title;
 *   - a spreadsheet adds everything or nothing, groups copies of one title, honours the numbers it carries and numbers the
 *     rest around them;
 *   - merging two pupils moves their library loans (in a transaction that is rolled back);
 *   - the head sees every screen; a librarian sees them all, lands on the library and is not bounced round in a loop, and
 *     cannot save the rules even by posting the head's own form; a teacher and a stranger see none;
 *   - a parent sees their own child's books by title and date and never another family's.
 *
 * It builds its own books (ZZLIB …) and loans in the demo school, borrows real pupils and puts them back, refuses to start
 * if the school already holds library data that is not its own, and removes everything it made, also after a failure.
 * Development databases only.
 */
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

// The development link answers in seconds and Prisma's defaults give up before it does; see verify-admissions-route.
{
  const appUrl = new URL(process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL!);
  appUrl.searchParams.set("pool_timeout", "90");
  appUrl.searchParams.set("connect_timeout", "60");
  process.env.APP_DATABASE_URL = appUrl.toString();
}
const { runWithTenantContext, withBypass } = await import("@/lib/tenant-context");
const engine = await import("@/lib/library-engine");
const { tenantTransaction } = await import("@/lib/prisma");
const { mergeStudents } = await import("@/lib/student-merge");
const { dayOf, addDays } = await import("@/lib/library-rules");

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";
const dbUrl = new URL(process.env.DIRECT_URL!);
dbUrl.searchParams.set("pool_timeout", "60");
dbUrl.searchParams.set("connect_timeout", "60");
const owner = new PrismaClient({ datasourceUrl: dbUrl.toString() });

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ""}`);
  if (!ok) failures += 1;
}

{
  const up = await fetch(`${BASE}/login`, { redirect: "manual" }).then((r) => r.status === 200, () => false);
  if (!up) {
    console.log(`  SKIPPED — nothing answering at ${BASE}. Start the app to run this.`);
    process.exit(0);
  }
}

const school = await owner.school.findUniqueOrThrow({ where: { slug: "hope-demo" }, select: { id: true } });
const policyBefore = await owner.schoolSettings.findUniqueOrThrow({
  where: { schoolId: school.id },
  select: { libraryPupilDays: true, libraryStaffDays: true, libraryPupilMax: true, libraryStaffMax: true, libraryBlockOverdue: true },
});
const startedAt = new Date();
const sessions: string[] = [];
const extraUsers: string[] = [];
const touchedStudents: { id: string; status: "ACTIVE" }[] = [];

const inSchool = <T,>(fn: () => Promise<T>) => runWithTenantContext({ schoolId: school.id }, fn);
const PREFIX = "ZZLIB ";

/* ───────────────────────────── clean up, and refuse to touch anyone else's ───────────────────────────── */

async function cleanUp() {
  // Deleting a book cascades to its copies and their loans.
  await owner.book.deleteMany({ where: { schoolId: school.id, title: { startsWith: PREFIX } } });
  await owner.auditLog.deleteMany({ where: { schoolId: school.id, action: { startsWith: "library." }, createdAt: { gte: startedAt } } });
  await owner.schoolSettings.update({ where: { schoolId: school.id }, data: policyBefore });
  for (const s of touchedStudents) await owner.student.update({ where: { id: s.id }, data: { status: s.status } });
  await withBypass(async () => {
    await owner.session.deleteMany({ where: { tokenHash: { in: sessions } } });
    await owner.membership.deleteMany({ where: { userId: { in: extraUsers } } });
    await owner.user.deleteMany({ where: { id: { in: extraUsers } } });
  });
}

if (process.argv.includes("--clean")) {
  await cleanUp();
  console.log("  Cleaned up what an earlier run left behind.");
  await owner.$disconnect();
  process.exit(0);
}
{
  const foreign = await owner.book.count({ where: { schoolId: school.id, NOT: { title: { startsWith: PREFIX } } } });
  if (foreign > 0) {
    console.log("  SKIPPED — this school already holds library books that are not this guard's. It will not touch them.");
    console.log("            If an earlier run was killed, clear what it left with: npm run verify:library-route -- --clean");
    process.exit(0);
  }
}
await cleanUp(); // anything an earlier, interrupted run left behind

/* ───────────────────────────── helpers ───────────────────────────── */

const head = await withBypass(() => owner.membership.findFirstOrThrow({ where: { schoolId: school.id, role: "OWNER" }, select: { userId: true } }));
const actor = { schoolId: school.id, userId: head.userId };

async function sessionFor(userId: string) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await withBypass(() => owner.session.create({ data: { userId, tokenHash, activeSchoolId: school.id, expiresAt: new Date(Date.now() + 3 * 3_600_000) } }));
  sessions.push(tokenHash);
  return token;
}
async function loginWithRole(role: "LIBRARIAN" | "TEACHER" | "PARENT", guardianId?: string) {
  const user = await withBypass(() => owner.user.create({ data: { name: `Verify ${role}`, email: `verify-library-${role.toLowerCase()}-${Date.now()}@example.test`, schoolId: school.id } }));
  extraUsers.push(user.id);
  await withBypass(() => owner.membership.create({ data: { schoolId: school.id, userId: user.id, role, ...(guardianId ? { guardianId } : {}) } }));
  return sessionFor(user.id);
}
const get = async (path: string, token?: string) => {
  const response = await fetch(`${BASE}${path}`, { headers: token ? { Cookie: `${COOKIE}=${token}` } : {}, redirect: "manual" });
  return { status: response.status, location: response.headers.get("location") ?? "", html: await response.text() };
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

type R = { ok: string } | { error: string };
const said = (r: R) => ("ok" in r ? r.ok : r.error);
const isError = (r: R, match?: RegExp) => "error" in r && (!match || match.test(r.error));
const isOk = (r: R) => "ok" in r;

const fields = (title: string, over: Record<string, string | null> = {}) => ({
  title, author: null, isbn: null, publisher: null, publishedYear: null, category: "Verify", shelf: null, replacementCost: null, notes: null, ...over,
});

const lend = (kind: "STUDENT" | "STAFF", borrowerId: string, accession: string) => inSchool(() => engine.lend(actor, { kind, borrowerId, accession }));
const giveBack = (accession: string) => inSchool(() => engine.returnBook(actor, { accession }));
const openLoansOf = (where: object) => owner.libraryLoan.count({ where: { schoolId: school.id, returnedOn: null, ...where } });
/** What a person at the desk would type: the number without its prefix and padding. */
const shortOf = (accessionNo: string) => String(Number(accessionNo.replace(/\D/g, "")));
const today = dayOf();
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

async function closeAll() {
  await owner.libraryLoan.updateMany({ where: { schoolId: school.id, returnedOn: null, copy: { book: { title: { startsWith: PREFIX } } } }, data: { returnedOn: today, outcome: "RETURNED" } });
}

try {
  /* ───────────────────────────── fixtures ───────────────────────────── */

  const pupils = await owner.student.findMany({ where: { schoolId: school.id, status: "ACTIVE", deletedAt: null }, orderBy: { admissionNo: "asc" }, take: 5, select: { id: true, firstName: true, lastName: true } });
  const teacher = await owner.staff.findFirst({ where: { schoolId: school.id, status: "ACTIVE", deletedAt: null }, orderBy: { staffNo: "asc" }, select: { id: true, firstName: true, lastName: true } });
  if (pupils.length < 5 || !teacher) {
    console.log("  SKIPPED — this guard needs five active pupils and a member of staff in the demo school.");
    process.exit(0);
  }
  const [p1, p2, p3, p4, p5] = pupils as [(typeof pupils)[number], (typeof pupils)[number], (typeof pupils)[number], (typeof pupils)[number], (typeof pupils)[number]];
  await owner.schoolSettings.update({ where: { schoolId: school.id }, data: { libraryPupilDays: 14, libraryStaffDays: 30, libraryPupilMax: 2, libraryStaffMax: 5, libraryBlockOverdue: true } });

  /* ───────────────────────────── the catalogue ───────────────────────────── */

  console.log("The catalogue");
  const atlas = await inSchool(() => engine.createBook(actor, fields(`${PREFIX}Atlas`, { replacementCost: "45.00" }), 3));
  check("a title is made with three copies", "id" in atlas);
  if (!("id" in atlas)) throw new Error("no book to go on with");
  const copies = await owner.bookCopy.findMany({ where: { bookId: atlas.id }, orderBy: { accessionNo: "asc" } });
  check("the copies are numbered ACC-nnnnn, all different", copies.length === 3 && copies.every((c) => /^ACC-\d{5}$/.test(c.accessionNo)) && new Set(copies.map((c) => c.accessionNo)).size === 3, copies.map((c) => c.accessionNo).join(","));
  const [A1, A2, A3] = copies as [(typeof copies)[number], (typeof copies)[number], (typeof copies)[number]];
  const numbersOf = copies.map((c) => Number(c.accessionNo.slice(4)));
  check("the numbers are consecutive", numbersOf[1]! === numbersOf[0]! + 1 && numbersOf[2]! === numbersOf[1]! + 1, numbersOf.join(","));

  check("a copy with the school's own number is added as typed", isOk(await inSchool(() => engine.addCopies(actor, { bookId: atlas.id, count: 1, accessionNo: "zzl-9001" }))) && (await owner.bookCopy.count({ where: { schoolId: school.id, accessionNo: "ZZL-9001" } })) === 1);
  check("the same number twice is refused", isError(await inSchool(() => engine.addCopies(actor, { bookId: atlas.id, count: 1, accessionNo: "ZZL-9001" })), /already the number/));
  check("no number and no count is refused", isError(await inSchool(() => engine.addCopies(actor, { bookId: atlas.id, count: 0 })), /between 1 and/));
  check("a book that is not found is refused", isError(await inSchool(() => engine.addCopies(actor, { bookId: "nope", count: 1 })), /not found/));
  check("more than 200 at once is refused", isError(await inSchool(() => engine.createBook(actor, fields(`${PREFIX}Too many`), 201)) as R, /between 0 and 200/));

  /* ───────────────────────────── lending ───────────────────────────── */

  console.log("\nLending");
  const first = await lend("STUDENT", p1.id, shortOf(A1.accessionNo));
  check("a typed short number finds the copy and lends it", isOk(first) && new RegExp(`${A1.accessionNo}.*lent to ${p1.firstName}`).test(said(first)), said(first));
  const loan1 = await owner.libraryLoan.findFirstOrThrow({ where: { copyId: A1.id, returnedOn: null } });
  check("it is due 14 days from today and carries who lent it", day(loan1.dueOn) === day(addDays(today, 14)) && loan1.issuedByUserId === head.userId && day(loan1.borrowedOn) === day(today));
  check("the same copy cannot go to a second person", isError(await lend("STUDENT", p2.id, A1.accessionNo), /already out/));
  check("a number nobody has is refused, saying so", isError(await lend("STUDENT", p2.id, "ZZ-NOPE"), /No book in this library is numbered ZZ-NOPE/));
  check("nothing typed is refused", isError(await lend("STUDENT", p2.id, "   "), /Scan or type/));
  check("a second book to the same pupil is allowed", isOk(await lend("STUDENT", p1.id, A2.accessionNo)));
  check("a third is refused: the limit is two", isError(await lend("STUDENT", p1.id, A3.accessionNo), new RegExp(`${p1.firstName}.*already has 2 books.*\\(2\\)`)));
  check("a person who is not in this school is refused", isError(await lend("STUDENT", "not-a-real-id", A3.accessionNo), /not found/));
  check("a member of staff is lent a book for 30 days", await (async () => {
    const r = await lend("STAFF", teacher.id, A3.accessionNo);
    const l = await owner.libraryLoan.findFirst({ where: { copyId: A3.id, returnedOn: null } });
    return isOk(r) && l?.staffId === teacher.id && l.studentId === null && day(l.dueOn) === day(addDays(today, 30));
  })());
  check("the database itself refuses a loan with two borrowers and a loan with none", await (async () => {
    const both = await owner.libraryLoan.create({ data: { schoolId: school.id, copyId: A1.id, studentId: p5.id, staffId: teacher.id, borrowedOn: today, dueOn: today } }).then(() => false, () => true);
    const none = await owner.libraryLoan.create({ data: { schoolId: school.id, copyId: A1.id, borrowedOn: today, dueOn: today } }).then(() => false, () => true);
    const half = await owner.libraryLoan.create({ data: { schoolId: school.id, copyId: A1.id, studentId: p5.id, borrowedOn: today, dueOn: today, returnedOn: today } }).then(() => false, () => true);
    return both && none && half;
  })());

  console.log("\nReturning");
  const back = await giveBack(A1.accessionNo.toLowerCase());
  check("a book is taken back by its number, whoever had it", isOk(back) && new RegExp(`returned by ${p1.firstName}`).test(said(back)), said(back));
  check("the loan is closed as RETURNED today, by the person who took it back", await (async () => {
    const l = await owner.libraryLoan.findUniqueOrThrow({ where: { id: loan1.id } });
    return day(l.returnedOn) === day(today) && l.outcome === "RETURNED" && l.closedByUserId === head.userId;
  })());
  check("taking it back twice is refused, saying it is not out", isError(await giveBack(A1.accessionNo), /not out/));
  check("a return of a number nobody has is refused", isError(await giveBack("ZZ-NOPE"), /No book/));
  check("a returned copy can go out again", isOk(await lend("STUDENT", p2.id, A1.accessionNo)));

  console.log("\nOverdue");
  // Spare copies, never lent until a check below lends them, so no refusal can be explained by "already out".
  check("(spare copies for the next checks)", isOk(await inSchool(() => engine.addCopies(actor, { bookId: atlas.id, count: 1, accessionNo: "ZZL-9002" }))) && isOk(await inSchool(() => engine.addCopies(actor, { bookId: atlas.id, count: 1, accessionNo: "ZZL-9003" }))));
  const loan2 = await owner.libraryLoan.findFirstOrThrow({ where: { copyId: A2.id, returnedOn: null } });
  await owner.libraryLoan.update({ where: { id: loan2.id }, data: { dueOn: addDays(today, -1) } });
  check("a pupil with an overdue book is refused another, though under the limit, and told why", isError(await lend("STUDENT", p1.id, "ZZL-9002"), /1 overdue book\. They must be returned first/));
  check("with the block switched off the same loan goes through", isOk(await inSchool(() => engine.savePolicy(actor, { pupilDays: 14, staffDays: 30, pupilMax: 2, staffMax: 5, blockOverdue: false }))) && isOk(await lend("STUDENT", p1.id, "ZZL-9002")));
  check("and the limit still holds with the block off: that is two, so a third is refused", isError(await lend("STUDENT", p1.id, "ZZL-9003"), new RegExp(`${p1.firstName}.*already has 2 books`)));
  await inSchool(() => engine.savePolicy(actor, { pupilDays: 14, staffDays: 30, pupilMax: 2, staffMax: 5, blockOverdue: true }));
  const late = await giveBack(A2.accessionNo);
  check("returning an overdue book says how late it was", isOk(late) && /1 day late/.test(said(late)), said(late));
  await giveBack("ZZL-9002");

  console.log("\nRenewing");
  await closeAll();
  check("a book is lent fresh", isOk(await lend("STUDENT", p3.id, A2.accessionNo)));
  const loan3 = await owner.libraryLoan.findFirstOrThrow({ where: { copyId: A2.id, returnedOn: null } });
  const renew = () => inSchool(() => engine.renewLoan(actor, loan3.id));
  check("the first renewal works", isOk(await renew()) && (await owner.libraryLoan.findUniqueOrThrow({ where: { id: loan3.id } })).renewals === 1);
  check("so does the second", isOk(await renew()) && (await owner.libraryLoan.findUniqueOrThrow({ where: { id: loan3.id } })).renewals === 2);
  check("the third is refused", isError(await renew(), /already been renewed 2 times/));
  await owner.libraryLoan.update({ where: { id: loan3.id }, data: { renewals: 0, dueOn: addDays(today, -3) } });
  check("a late loan cannot be renewed: take it back first", isError(await renew(), /overdue/));
  await giveBack(A2.accessionNo);
  check("a closed loan cannot be renewed", isError(await renew(), /already been returned/));
  check("a loan that is not found is refused", isError(await inSchool(() => engine.renewLoan(actor, "nope")), /not found/));

  console.log("\nWho may borrow");
  await owner.student.update({ where: { id: p4.id }, data: { status: "SUSPENDED" } });
  touchedStudents.push({ id: p4.id, status: "ACTIVE" });
  check("a suspended pupil is refused", isError(await lend("STUDENT", p4.id, A1.accessionNo), /not on the roll/));
  await owner.student.update({ where: { id: p4.id }, data: { status: "ACTIVE" } });

  /* ───────────────────────────── lost, withdrawn, deleted ───────────────────────────── */

  console.log("\nLost and withdrawn");
  await closeAll();
  check("a copy out is lent", isOk(await lend("STUDENT", p3.id, A1.accessionNo)));
  check("a copy that is out cannot be withdrawn", isError(await inSchool(() => engine.changeCopy(actor, A1.id, "withdraw", "")), /Take it back first/));
  const lost = await inSchool(() => engine.changeCopy(actor, A1.id, "lost", "left on the bus"));
  check("recorded as lost, it names the borrower and what it would cost to replace", isOk(lost) && new RegExp(`lost, by ${p3.firstName}.*GH₵45\\.00`).test(said(lost)), said(lost));
  check("the loan is closed LOST against the borrower, with the reason", await (async () => {
    const l = await owner.libraryLoan.findFirstOrThrow({ where: { copyId: A1.id }, orderBy: { createdAt: "desc" } });
    return l.outcome === "LOST" && l.returnedOn !== null && l.note === "left on the bus" && l.studentId === p3.id;
  })());
  check("the copy is LOST and the borrower no longer holds it", (await owner.bookCopy.findUniqueOrThrow({ where: { id: A1.id } })).status === "LOST" && (await openLoansOf({ studentId: p3.id })) === 0);
  check("a lost copy cannot be lent", isError(await lend("STUDENT", p2.id, A1.accessionNo), /lost/));
  check("recording it lost twice is refused", isError(await inSchool(() => engine.changeCopy(actor, A1.id, "lost", "")), /already recorded as lost/));
  check("a book that turns up goes back into stock", isOk(await inSchool(() => engine.changeCopy(actor, A1.id, "reinstate", ""))) && isOk(await lend("STUDENT", p2.id, A1.accessionNo)));
  await closeAll();
  check("a copy on the shelf may be withdrawn, and then cannot be lent", isOk(await inSchool(() => engine.changeCopy(actor, A3.id, "withdraw", "water damage"))) && isError(await lend("STUDENT", p2.id, A3.accessionNo), /withdrawn/));
  check("a withdrawn copy may be put back", isOk(await inSchool(() => engine.changeCopy(actor, A3.id, "reinstate", ""))));

  console.log("\nDeleting");
  check("a copy that has been lent cannot be deleted", isError(await inSchool(() => engine.deleteCopy(actor, A1.id)), /has been lent/));
  const spare = await owner.bookCopy.findFirstOrThrow({ where: { schoolId: school.id, accessionNo: "ZZL-9003" } });
  check("a copy that was never lent can, and is then gone", isOk(await inSchool(() => engine.deleteCopy(actor, spare.id))) && (await owner.bookCopy.count({ where: { id: spare.id } })) === 0);
  check("a title that has been lent cannot be deleted, and says how many times", isError(await inSchool(() => engine.deleteBook(actor, atlas.id)), /has been lent \d+ times?/));
  const blank = await inSchool(() => engine.createBook(actor, fields(`${PREFIX}Blank`), 1));
  check("a title that was never lent can", "id" in blank && isOk(await inSchool(() => engine.deleteBook(actor, blank.id))) && (await owner.book.count({ where: { id: blank.id } })) === 0);

  /* ───────────────────────────── two desks at once ───────────────────────────── */

  console.log("\nTwo desks at once");
  await closeAll();
  let singles = 0;
  for (let round = 1; round <= 3; round += 1) {
    const [x, y] = await Promise.all([lend("STUDENT", p1.id, A2.accessionNo), lend("STUDENT", p2.id, A2.accessionNo)]);
    const open = await openLoansOf({ copyId: A2.id });
    if (open === 1 && [x, y].filter(isOk).length === 1) singles += 1;
    await closeAll();
  }
  check("two desks lending the same copy at once make ONE loan (three rounds)", singles === 3, `${singles} of 3 rounds`);
  const lot = await Promise.all([lend("STUDENT", p5.id, A1.accessionNo), lend("STUDENT", p5.id, A2.accessionNo), lend("STUDENT", p5.id, A3.accessionNo)]);
  check("three desks lending to one pupil at once cannot push them past the limit of two", (await openLoansOf({ studentId: p5.id })) === 2 && lot.filter(isOk).length === 2, `${lot.filter(isOk).length} ok, ${await openLoansOf({ studentId: p5.id })} open`);
  await closeAll();
  await lend("STUDENT", p1.id, A1.accessionNo);
  const twice = await Promise.all([giveBack(A1.accessionNo), giveBack(A1.accessionNo)]);
  check("two returns at once close the loan once", twice.filter(isOk).length === 1 && twice.filter((r) => isError(r)).length === 1);

  /* ───────────────────────────── the audit trail ───────────────────────────── */

  console.log("\nThe audit trail");
  const rows = await owner.auditLog.findMany({ where: { schoolId: school.id, action: { startsWith: "library." }, createdAt: { gte: startedAt } } });
  const kinds = new Set(rows.map((r) => r.action));
  check("lending, returning and renewing wrote nothing to it", !["library.lend", "library.return", "library.renew"].some((a) => kinds.has(a)));
  check("losing a copy, withdrawing one, deleting a title and changing the rules did", ["library.copy.lost", "library.copy.withdraw", "library.book.delete", "library.policy"].every((a) => kinds.has(a)), [...kinds].join(", "));
  const lostRow = rows.find((r) => r.action === "library.copy.lost")!;
  const blob = JSON.stringify(lostRow.after) + JSON.stringify(lostRow.before);
  check("a lost-copy row names no pupil and no title", !blob.includes(p3.firstName) && !blob.includes(p3.lastName) && !/Atlas/.test(blob), blob);

  /* ───────────────────────────── a spreadsheet ───────────────────────────── */

  console.log("\nThe spreadsheet");
  await closeAll();
  const dup = `accession_no,title,price\nZZL-9001,${PREFIX}Import dup,10\n`;
  const checkedDup = await inSchool(() => engine.checkCatalogue(school.id, dup));
  check("the check reports a number the library already holds, with its line", checkedDup.problems.length === 1 && checkedDup.problems[0]!.line === 2 && /ZZL-9001 is already in the library/.test(checkedDup.problems[0]!.message), JSON.stringify(checkedDup));
  const refused = await inSchool(() => engine.addCatalogue(actor, dup));
  check("adding it is refused, and nothing was added", isError(refused as R) && (await owner.book.count({ where: { schoolId: school.id, title: `${PREFIX}Import dup` } })) === 0);
  const seq = await owner.numberSequence.findUnique({ where: { schoolId_key: { schoolId: school.id, key: "ACCESSION" } } });
  const nextN = seq?.next ?? 1;
  const typedNext = `ACC-${String(nextN).padStart(5, "0")}`;
  const sheet = [
    "accession_no,title,author,isbn,category,price",
    `ZZL-IMP-1,${PREFIX}Import A,Someone,978-0385474542,Novels,12.5`,
    `,${PREFIX}Import A,Someone,9780385474542,Novels,12.5`,
    `${typedNext},${PREFIX}Import B,,,,`,
    `,${PREFIX}Import C,,,,`,
  ].join("\n");
  const preview = await inSchool(() => engine.checkCatalogue(school.id, sheet));
  check("the check counts three books and four copies, writing nothing", preview.problems.length === 0 && preview.books === 3 && preview.copies === 4 && (await owner.book.count({ where: { schoolId: school.id, title: { startsWith: `${PREFIX}Import` } } })) === 0, JSON.stringify(preview));
  const added = await inSchool(() => engine.addCatalogue(actor, sheet));
  check("adding it adds three books and four copies", isOk(added as R) && /3 books and 4 copies/.test(said(added as R)), said(added as R));
  const importA = await owner.book.findFirstOrThrow({ where: { schoolId: school.id, title: `${PREFIX}Import A` }, include: { copies: true } });
  check("two rows of one title became one book with two copies, the ISBN stored as digits and the price to two places", importA.copies.length === 2 && importA.isbn === "9780385474542" && importA.replacementCost?.toFixed(2) === "12.50");
  check("the number the file carries was kept", importA.copies.some((c) => c.accessionNo === "ZZL-IMP-1"));
  const importC = await owner.book.findFirstOrThrow({ where: { schoolId: school.id, title: `${PREFIX}Import C` }, include: { copies: true } });
  const nextAfter = `ACC-${String(nextN + 1).padStart(5, "0")}`;
  check("a blank number is numbered around the numbers the file itself carries (it skipped the one typed)", importC.copies[0]?.accessionNo !== typedNext && /^ACC-\d{5}$/.test(importC.copies[0]?.accessionNo ?? "") && (await owner.bookCopy.count({ where: { schoolId: school.id, accessionNo: typedNext } })) === 1, `${importC.copies[0]?.accessionNo} (typed ${typedNext}, would have been ${nextAfter})`);
  check("an import is audited, with counts and no titles", await (async () => {
    const r = await owner.auditLog.findFirst({ where: { schoolId: school.id, action: "library.import", createdAt: { gte: startedAt } } });
    return r !== null && JSON.stringify(r.after) === JSON.stringify({ books: 3, copies: 4 });
  })());
  check("a file with no rows, and one with no title, are refused", (await inSchool(() => engine.checkCatalogue(school.id, "title\n"))).problems.length === 1 && (await inSchool(() => engine.checkCatalogue(school.id, "title,author\n,Someone\n"))).problems[0]?.line === 2);

  /* ───────────────────────────── merging two pupils ───────────────────────────── */

  console.log("\nMerging two pupils");
  class Rollback extends Error {}
  let merged: { loansMoved: number; loansOnKeeper: number; loansOnRemoved: number; ok: boolean } | null = null;
  try {
    await inSchool(() =>
      tenantTransaction(school.id, async (tx) => {
        const keeper = await tx.student.create({ data: { schoolId: school.id, admissionNo: "ZZLIB-KEEP", firstName: "Zz", lastName: "Keeper", gender: "MALE" } });
        await tx.libraryLoan.create({ data: { schoolId: school.id, copyId: A1.id, studentId: p4.id, borrowedOn: today, dueOn: addDays(today, 14), returnedOn: today, outcome: "RETURNED" } });
        const result = await mergeStudents(tx, { schoolId: school.id, actorUserId: head.userId, keepId: keeper.id, removeId: p4.id });
        merged = {
          ok: result.ok,
          loansMoved: result.ok ? (result.moved["Library loans"] ?? 0) : 0,
          loansOnKeeper: await tx.libraryLoan.count({ where: { studentId: keeper.id } }),
          loansOnRemoved: await tx.libraryLoan.count({ where: { studentId: p4.id } }),
        };
        throw new Rollback();
      }, { timeout: 180_000, maxWait: 20_000 }),
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const m = merged as { loansMoved: number; loansOnKeeper: number; loansOnRemoved: number; ok: boolean } | null;
  check("a pupil's loans, returned ones included, move to the record that is kept", m !== null && m.ok && m.loansMoved >= 1 && m.loansOnKeeper === m.loansMoved && m.loansOnRemoved === 0, JSON.stringify(m));
  check("the merge was rolled back: the pupil still exists", (await owner.student.count({ where: { id: p4.id, deletedAt: null } })) === 1 && (await owner.student.count({ where: { admissionNo: "ZZLIB-KEEP" } })) === 0);

  /* ───────────────────────────── the screens ───────────────────────────── */

  console.log("\nThe screens, as the head");
  await closeAll();
  await lend("STUDENT", p2.id, A1.accessionNo);
  await owner.libraryLoan.updateMany({ where: { copyId: A1.id, returnedOn: null }, data: { dueOn: addDays(today, -2) } });
  const headToken = await sessionFor(head.userId);
  const librarian = await loginWithRole("LIBRARIAN");
  const teacherToken = await loginWithRole("TEACHER");

  const PAGES: Array<[string, RegExp]> = [
    ["/library", /Library[\s\S]*Overdue/],
    ["/library/desk", /Take a book back/],
    [`/library/desk?kind=STUDENT&id=${p2.id}`, new RegExp(`${p2.firstName}[\\s\\S]*Atlas`)],
    [`/library/desk?q=${encodeURIComponent(p2.lastName)}`, new RegExp(p2.lastName)],
    ["/library/books", /ZZLIB Atlas/],
    ["/library/books/new", /Add this book/],
    [`/library/books/${atlas.id}`, /ZZL-9001[\s\S]*Who has had it/],
    ["/library/loans", new RegExp(p2.lastName)],
    ["/library/loans?show=overdue", /Overdue books/],
    ["/library/import", /Check the file/],
    ["/library/settings", /name="pupilDays"/],
  ];
  for (const [path, expect] of PAGES) {
    const r = await get(path, headToken);
    check(`${path} opens for the head and shows what it should`, r.status === 200 && expect.test(text(r.html) + r.html), `${r.status} ${r.location}`);
  }
  const overview = text((await get("/library", headToken)).html);
  check("the overview lists the overdue book with how late it is", /ZZLIB Atlas/.test(overview) && /overdue 2d/.test(overview), overview.slice(0, 300));
  const pupilPage = text((await get(`/students/${p2.id}`, headToken)).html);
  check("the pupil's own page shows their books, with the overdue flag", /Library · 1 book out, 1 overdue/.test(pupilPage) && /ZZLIB Atlas/.test(pupilPage));
  check("a search with no match says so", /No book matches that search/.test(text((await get("/library/books?q=zzzznomatch", headToken)).html)));

  console.log("\nThe screens, as a librarian");
  for (const [path] of PAGES.filter(([p]) => p !== "/library/settings")) {
    const r = await get(path, librarian);
    check(`${path} opens for a librarian`, r.status === 200, `${r.status} ${r.location}`);
  }
  const rules = await get("/library/settings", librarian);
  check("the rules are shown to a librarian as text, with no form to change them", rules.status === 200 && !/name="pupilDays"/.test(rules.html) && /A head teacher or the proprietor changes these/.test(text(rules.html)));
  const dash = await get("/dashboard", librarian);
  check("a librarian-only login goes from the dashboard to the library", dash.status === 307 && dash.location.endsWith("/library"), `${dash.status} ${dash.location}`);
  const students = await get("/students", librarian);
  check("a page they may not open sends them to the library, which opens: no loop", students.status === 307 && students.location.endsWith("/library") && (await get("/library", librarian)).status === 200, `${students.status} ${students.location}`);
  const payroll = await get("/payroll", librarian);
  check("the staff's pay is not theirs to read", payroll.status !== 200, `${payroll.status} ${payroll.location}`);

  console.log("\nThe rules, and who can save them");
  {
    const html = (await get("/library/settings", headToken)).html;
    const start = html.split("<form").findIndex((chunk) => chunk.includes('name="pupilDays"'));
    const chunk = start >= 0 ? html.split("<form")[start]!.split("</form>")[0]! : "";
    const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const hidden = [...chunk.matchAll(/<input\b([^>]*)>/g)]
      .map((m) => ({ name: /\bname="([^"]*)"/.exec(m[1]!)?.[1], value: decode(/\bvalue="([^"]*)"/.exec(m[1]!)?.[1] ?? ""), type: /\btype="([^"]*)"/.exec(m[1]!)?.[1] }))
      .filter((f) => f.name && (f.type === "hidden" || String(f.name).startsWith("$ACTION")));
    const post = async (token: string, over: Record<string, string>) => {
      const body = new FormData();
      for (const f of hidden) body.append(f.name!, f.value);
      for (const [k, v] of Object.entries(over)) body.append(k, v);
      const response = await fetch(`${BASE}/library/settings`, { method: "POST", headers: { Cookie: `${COOKIE}=${token}` }, body, redirect: "manual" });
      return response.status;
    };
    const days = async () => (await owner.schoolSettings.findUniqueOrThrow({ where: { schoolId: school.id }, select: { libraryPupilDays: true } })).libraryPupilDays;
    const over = { pupilDays: "21", staffDays: "30", pupilMax: "2", staffMax: "5", blockOverdue: "yes" };
    check("(the head's form was found, with its action fields)", hidden.some((f) => String(f.name).startsWith("$ACTION")), `${hidden.length} hidden fields`);
    await post(librarian, over);
    check("a librarian posting the head's own form changes nothing", (await days()) === 14, `pupilDays is ${await days()}`);
    await post(teacherToken, over);
    check("neither does a teacher", (await days()) === 14);
    await post(headToken, over);
    check("the same post from the head DOES change it (so the two refusals above mean something)", (await days()) === 21, `pupilDays is ${await days()}`);
    await owner.schoolSettings.update({ where: { schoolId: school.id }, data: { libraryPupilDays: 14 } });
  }

  console.log("\nA teacher and a stranger");
  for (const path of ["/library", "/library/desk", "/library/books", "/library/import"]) {
    const r = await get(path, teacherToken);
    check(`a teacher is sent away from ${path}, to their own screen`, r.status === 307 && /\/assessments\/sheet$/.test(r.location), `${r.status} ${r.location}`);
  }
  const stranger = await get("/library");
  check("someone signed out is sent to sign in", stranger.status === 307 && /\/login/.test(stranger.location), `${stranger.status} ${stranger.location}`);

  /* ───────────────────────────── a parent ───────────────────────────── */

  console.log("\nA parent");
  const guardian = await owner.guardian.findFirst({
    where: { schoolId: school.id, deletedAt: null, students: { some: { student: { deletedAt: null, status: "ACTIVE" } } } },
    select: { id: true, students: { select: { studentId: true, student: { select: { status: true, deletedAt: true } } } } },
  });
  const mine = guardian?.students.filter((s) => s.student.status === "ACTIVE" && !s.student.deletedAt).map((s) => s.studentId) ?? [];
  const theirs = mine.length ? await owner.student.findFirst({ where: { schoolId: school.id, status: "ACTIVE", deletedAt: null, id: { notIn: mine } }, select: { id: true } }) : null;
  if (!guardian || mine.length === 0 || !theirs) {
    console.log("  --   no family with a child, and another child outside it, in this school; the parent checks are skipped");
  } else {
    await closeAll();
    const parent = await loginWithRole("PARENT", guardian.id);
    const book1 = await inSchool(() => engine.createBook(actor, fields(`${PREFIX}Mine`, { author: "ZZ Author" }), 1));
    const book2 = await inSchool(() => engine.createBook(actor, fields(`${PREFIX}Theirs`), 1));
    if (!("id" in book1) || !("id" in book2)) throw new Error("no books for the parent checks");
    const c1 = await owner.bookCopy.findFirstOrThrow({ where: { bookId: book1.id } });
    const c2 = await owner.bookCopy.findFirstOrThrow({ where: { bookId: book2.id } });
    const mineId = mine[0]!;
    check("a book is lent to the parent's child and another to a child outside the family", isOk(await lend("STUDENT", mineId, c1.accessionNo)) && isOk(await lend("STUDENT", theirs.id, c2.accessionNo)));
    const page = await get(`/portal/${mineId}`, parent);
    const words = text(page.html);
    check("the parent sees their child's book and when it is due", page.status === 200 && /ZZLIB Mine/.test(words) && /Due back/.test(words), `${page.status} ${page.location}`);
    check("not the library's number, not the author, and not another family's book", !words.includes(c1.accessionNo) && !/ZZ Author/.test(words) && !/ZZLIB Theirs/.test(words) && !words.includes(c2.accessionNo));
    await owner.libraryLoan.updateMany({ where: { copyId: c1.id, returnedOn: null }, data: { dueOn: addDays(today, -4) } });
    check("a late book is flagged to the parent", /overdue 4d/.test(text((await get(`/portal/${mineId}`, parent)).html)));
    const other = await get(`/portal/${theirs.id}`, parent);
    check("another family's child is a 404 for them, books or not", other.status === 404, `${other.status}`);
    const lib = await get("/library", parent);
    check("a parent cannot open the library", lib.status === 307 && /\/portal/.test(lib.location), `${lib.status} ${lib.location}`);
    await giveBack(c1.accessionNo);
    check("once it is returned the card disappears", !/ZZLIB Mine/.test(text((await get(`/portal/${mineId}`, parent)).html)));
  }
} finally {
  await cleanUp().catch((e) => console.log(`  (clean-up failed: ${String(e).slice(0, 200)} — run with -- --clean)`));
  await owner.$disconnect();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

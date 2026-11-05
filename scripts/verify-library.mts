/**
 * The library: its rules, and the shape of the code around them.
 *
 *   npm run verify:library
 *
 * No database and no server. Every expected value below was worked out BY HAND and written in as a constant (dates counted
 * off a calendar, amounts by eye). None is computed with the code under test, because a check that derives its answer from
 * the function it is checking proves only that the function agrees with itself.
 *
 * The shape checks read the source with comments stripped: this codebase explains its mistakes at length, and a comment
 * naming a rule would satisfy a check that the rule is not there. `verify:library-route` drives the real screens and the
 * engine against the database, including two people lending the same copy at the same instant.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ACCESSION_SHAPE,
  CATALOGUE_ROW_CAP,
  DEFAULT_POLICY,
  MAX_RENEWALS,
  accessionCandidates,
  addDays,
  borrowerProblem,
  dayOf,
  daysOverdue,
  dueDateFor,
  groupIntoBooks,
  lendCheck,
  limitFor,
  loanState,
  normaliseAccession,
  periodFor,
  readBook,
  readCatalogue,
  readCost,
  readDay,
  readIsbn,
  readPolicy,
  renewCheck,
  type LibraryPolicy,
} from "@/lib/library-rules";
import { LEADERSHIP, LIBRARY, LIBRARY_POLICY, NAV, OFFICE, landingFor, isLibrarianOnly } from "@/lib/permissions";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  if (!ok) failures += 1;
}

const root = resolve(import.meta.dirname, "..");
const code = (file: string) =>
  readFileSync(resolve(root, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(full) ? [full] : [];
  });
/** The text of one exported function, up to the next export. */
const bodyOf = (source: string, name: string) => {
  const start = source.indexOf(`export async function ${name}(`);
  if (start === -1) return "";
  const next = source.indexOf("\nexport ", start + 10);
  return source.slice(start, next === -1 ? undefined : next);
};

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

/* ───────────────────────────── dates ───────────────────────────── */

console.log("Dates");
check("a time of day is dropped, to midnight UTC", iso(dayOf(new Date("2026-11-05T17:45:00Z"))) === "2026-11-05");
check("14 days from 5 Nov 2026 is 19 Nov", iso(addDays(d("2026-11-05"), 14)) === "2026-11-19");
check("14 days from 20 Nov crosses into December (4 Dec)", iso(addDays(d("2026-11-20"), 14)) === "2026-12-04");
check("10 days from 25 Dec crosses into the next year (4 Jan)", iso(addDays(d("2026-12-25"), 10)) === "2027-01-04");
check("a form's date is read", iso(readDay("2026-11-05")) === "2026-11-05");
check("31 February is refused, not rolled into March", readDay("2026-02-31") === null);
check("29 February 2028 is a date and 29 February 2026 is not", iso(readDay("2028-02-29")) === "2028-02-29" && readDay("2026-02-29") === null);
check("text that is not a date is refused", readDay("5 Nov 2026") === null && readDay("") === null);

/* ───────────────────────────── accession numbers ───────────────────────────── */

console.log("\nAccession numbers");
check("what was typed is tidied: trimmed, spaces collapsed, upper case", normaliseAccession("  acc  00001 ") === "ACC 00001");
check("a typed 1 may mean ACC-00001, and 1 itself comes first", JSON.stringify(accessionCandidates("1", "ACC-", 5)) === JSON.stringify(["1", "ACC-00001"]));
check("a full number has no padded form", JSON.stringify(accessionCandidates("acc-00001", "ACC-", 5)) === JSON.stringify(["ACC-00001"]));
check("a school's own number is tried as typed", JSON.stringify(accessionCandidates(" b-17 ", "ACC-", 5)) === JSON.stringify(["B-17"]));
check("digits are padded to the width given", JSON.stringify(accessionCandidates("007", "B-", 4)) === JSON.stringify(["007", "B-0007"]));
check("nothing typed is no candidate", accessionCandidates("   ", "ACC-", 5).length === 0);
check("the library's own shape is ACC- and five digits", ACCESSION_SHAPE.prefix === "ACC-" && ACCESSION_SHAPE.padding === 5);

/* ───────────────────────────── a loan's state is derived ───────────────────────────── */

console.log("\nA loan is overdue when its date has passed, and only then");
const open = (dueOn: string) => ({ dueOn: d(dueOn), returnedOn: null, outcome: null });
check("due today is not yet late", loanState(open("2026-11-19"), d("2026-11-19")) === "OUT");
check("due yesterday is overdue by one day", loanState(open("2026-11-19"), d("2026-11-20")) === "OVERDUE" && daysOverdue(open("2026-11-19"), d("2026-11-20")) === 1);
check("19 Nov to 4 Dec is 15 days late (Nov has 30)", daysOverdue(open("2026-11-19"), d("2026-12-04")) === 15);
check("a book not yet due is 0 days late", daysOverdue(open("2026-11-19"), d("2026-11-10")) === 0);
check("a returned loan is RETURNED, however late it was", loanState({ dueOn: d("2026-11-01"), returnedOn: d("2026-11-30"), outcome: "RETURNED" }, d("2026-12-31")) === "RETURNED");
check("a loan closed as lost is LOST and never overdue", loanState({ dueOn: d("2026-11-01"), returnedOn: d("2026-11-30"), outcome: "LOST" }, d("2026-12-31")) === "LOST");
check("a closed loan owes no days", daysOverdue({ dueOn: d("2026-11-01"), returnedOn: d("2026-11-30"), outcome: "RETURNED" }, d("2026-12-31")) === 0);

/* ───────────────────────────── the rules the school sets ───────────────────────────── */

console.log("\nThe school's rules");
const policy: LibraryPolicy = { pupilDays: 14, staffDays: 30, pupilMax: 2, staffMax: 5, blockOverdue: true };
check("the starting rules are 14 and 30 days, 2 and 5 books, overdue blocks", JSON.stringify(DEFAULT_POLICY) === JSON.stringify(policy));
check("a pupil's period and limit, and a member of staff's", periodFor("STUDENT", policy) === 14 && periodFor("STAFF", policy) === 30 && limitFor("STUDENT", policy) === 2 && limitFor("STAFF", policy) === 5);
check("a pupil lent a book on 5 Nov is due 19 Nov; a teacher on 5 Dec", iso(dueDateFor("STUDENT", policy, d("2026-11-05"))) === "2026-11-19" && iso(dueDateFor("STAFF", policy, d("2026-11-05"))) === "2026-12-05");

const form = (over: Record<string, string> = {}) => ({ pupilDays: "14", staffDays: "30", pupilMax: "2", staffMax: "5", blockOverdue: "yes", ...over });
check("the form is read", (() => { const r = readPolicy(form()); return r.ok && JSON.stringify(r.value) === JSON.stringify(policy); })());
check("'no' turns the overdue block off", (() => { const r = readPolicy(form({ blockOverdue: "no" })); return r.ok && r.value.blockOverdue === false; })());
for (const [label, over] of [
  ["zero days", { pupilDays: "0" }],
  ["more than a year", { staffDays: "366" }],
  ["1e1 (a number to JavaScript, not a number of days)", { pupilDays: "1e1" }],
  ["7.5 days", { pupilDays: "7.5" }],
  ["minus 3", { pupilMax: "-3" }],
  ["blank", { staffMax: "" }],
  ["more than fifty books", { pupilMax: "51" }],
] as const) {
  check(`${label} is refused`, !readPolicy(form(over)).ok);
}

/* ───────────────────────────── may it go out? ───────────────────────────── */

console.log("\nMay this copy go out to this person?");
const copy = { accessionNo: "ACC-00001", title: "Things Fall Apart", status: "ACTIVE" as const, onLoan: false };
const ask = (over: Record<string, unknown> = {}, pol: LibraryPolicy = policy) =>
  lendCheck({ kind: "STUDENT", borrowerName: "Ama Ofori", held: 0, overdue: 0, copy, policy: pol, ...over } as Parameters<typeof lendCheck>[0]);
const refusal = (r: ReturnType<typeof ask>) => ("error" in r ? r.error : "");
check("a free copy to a pupil holding nothing", ask().ok);
check("a copy recorded as lost is refused", /lost/.test(refusal(ask({ copy: { ...copy, status: "LOST" } }))));
check("a withdrawn copy is refused", /withdrawn/.test(refusal(ask({ copy: { ...copy, status: "WITHDRAWN" } }))));
check("a copy already out is refused, naming it", /Things Fall Apart \(ACC-00001\) is already out/.test(refusal(ask({ copy: { ...copy, onLoan: true } }))));
check("a pupil with one book may take a second", ask({ held: 1 }).ok);
check("a pupil with two is refused, with the limit and their name", /Ama Ofori already has 2 books.*\(2\)/.test(refusal(ask({ held: 2 }))));
check("a member of staff may hold five and not six", ask({ kind: "STAFF", held: 4 }).ok && !ask({ kind: "STAFF", held: 5 }).ok);
check("an overdue book stops the next loan", /1 overdue book\. They must be returned first/.test(refusal(ask({ held: 1, overdue: 1 }))));
check("two overdue are counted in the plural", /2 overdue books/.test(refusal(ask({ held: 2, overdue: 2 }))));
check("with the block switched off an overdue book does not stop it", ask({ held: 1, overdue: 1 }, { ...policy, blockOverdue: false }).ok);
check("the limit still applies with the block switched off", !ask({ held: 2, overdue: 1 }, { ...policy, blockOverdue: false }).ok);

console.log("\nRenewing");
const loan = (over: Record<string, unknown> = {}) => ({ dueOn: d("2026-11-19"), returnedOn: null, outcome: null, renewals: 0, ...over }) as Parameters<typeof renewCheck>[0];
check("an open loan not yet late may be renewed", renewCheck(loan(), "ACTIVE", d("2026-11-10")).ok);
check("due today may still be renewed", renewCheck(loan(), "ACTIVE", d("2026-11-19")).ok);
check("an overdue loan may not: take it back first", !renewCheck(loan(), "ACTIVE", d("2026-11-20")).ok);
check(`not more than ${MAX_RENEWALS} times`, MAX_RENEWALS === 2 && renewCheck(loan({ renewals: 1 }), "ACTIVE", d("2026-11-10")).ok && !renewCheck(loan({ renewals: 2 }), "ACTIVE", d("2026-11-10")).ok);
check("a returned loan may not", !renewCheck(loan({ returnedOn: d("2026-11-12"), outcome: "RETURNED" }), "ACTIVE", d("2026-11-13")).ok);
check("a copy that has left stock may not", !renewCheck(loan(), "LOST", d("2026-11-10")).ok);

console.log("\nWho may borrow");
const person = (status: string, deletedAt: Date | null = null) => ({ status: status as never, deletedAt, name: "Ama Ofori" });
check("a pupil on the roll", borrowerProblem("STUDENT", person("ACTIVE")) === null);
for (const status of ["SUSPENDED", "GRADUATED", "WITHDRAWN", "TRANSFERRED", "APPLICANT", "ADMITTED"]) {
  check(`a ${status.toLowerCase()} pupil is refused`, borrowerProblem("STUDENT", person(status)) !== null);
}
check("a removed record is refused whatever its status", /removed/.test(borrowerProblem("STUDENT", person("ACTIVE", new Date())) ?? ""));
check("staff who are active or on leave may borrow; resigned or retired may not", borrowerProblem("STAFF", person("ACTIVE")) === null && borrowerProblem("STAFF", person("ON_LEAVE")) === null && borrowerProblem("STAFF", person("RESIGNED")) !== null && borrowerProblem("STAFF", person("RETIRED")) !== null);

/* ───────────────────────────── a title ───────────────────────────── */

console.log("\nA title, read from a form");
const NOW = new Date("2026-11-05T00:00:00Z");
const book = (over: Record<string, string> = {}) => readBook({ title: "Things Fall Apart", ...over }, NOW);
check("a title alone is enough", book().ok);
check("no title is refused", !readBook({ title: "   " }, NOW).ok);
check("spaces inside a title are collapsed", (() => { const r = readBook({ title: "  Kofi   and the  Drum " }, NOW); return r.ok && r.value.title === "Kofi and the Drum"; })());
check("ISBN-13 with hyphens is stored as digits", (() => { const r = readIsbn("978-0-385-47454-2"); return r.ok && r.value === "9780385474542"; })());
check("ISBN-10 ending in X, lower case, is accepted", (() => { const r = readIsbn("0-385-47454-x"); return r.ok && r.value === "038547454X"; })());
check("a blank ISBN is none, and 12345 is refused", (() => { const a = readIsbn(""); return a.ok && a.value === null && !readIsbn("12345").ok; })());
check("next year may be a publication year; the year after may not", book({ publishedYear: "2027" }).ok && !book({ publishedYear: "2028" }).ok);
check("1000 is a year; 999, 'abcd' and 19999 are not", book({ publishedYear: "1000" }).ok && !book({ publishedYear: "999" }).ok && !book({ publishedYear: "abcd" }).ok && !book({ publishedYear: "19999" }).ok);
const cost = (v: string) => { const r = readCost(v); return r.ok ? r.value : "ERR"; };
check("35 is 35.00, 12.5 is 12.50", cost("35") === "35.00" && cost("12.5") === "12.50");
check("a cedi sign, GHS and thousands separators are read", cost("GH₵ 1,250.5") === "1250.50" && cost("GHS 7") === "7.00");
check("blank is no cost", cost("") === null && cost("   ") === null);
check("a fraction of a pesewa, a minus sign and 1e3 are refused", cost("12.345") === "ERR" && cost("-5") === "ERR" && cost("1e3") === "ERR");

/* ───────────────────────────── the catalogue, from a spreadsheet ───────────────────────────── */

console.log("\nThe catalogue, from a spreadsheet");
const row = (over: Record<string, string> = {}) => ({ accession_no: "", title: "Kofi and the Drum", author: "Ama Ata Aidoo", ...over });
{
  const r = readCatalogue([row({ title: "A" }), row({ title: "" }), row({ title: "C" })], NOW);
  check("a bad row is reported on its own line (the header is line 1)", r.problems.length === 1 && r.problems[0]!.line === 3, JSON.stringify(r.problems));
  check("a file with any problem adds nothing", r.rows.length === 0);
}
{
  const r = readCatalogue([row({ accession_no: "B-1" }), row({ title: "Other", accession_no: "b-2" }), row({ title: "Third", accession_no: " B-1 " })], NOW);
  check("a number repeated in the file is a problem, naming the first line", r.problems.length === 1 && r.problems[0]!.line === 4 && /line 2/.test(r.problems[0]!.message), JSON.stringify(r.problems));
}
{
  const r = readCatalogue([row({ accession_no: "ACC-00007", book: "x" }), { acc_no: "Z9", book_title: "Alias title", subject: "Science", cost: "10" }], NOW);
  check("headings may be spelt a few ways (acc_no, book_title, subject, cost)", r.problems.length === 0 && r.rows[1]?.accessionNo === "Z9" && r.rows[1]?.title === "Alias title" && r.rows[1]?.category === "Science" && r.rows[1]?.replacementCost === "10.00", JSON.stringify(r));
  check("a blank accession number is left for the library to number", r.rows[0]?.accessionNo === "ACC-00007" && readCatalogue([row()], NOW).rows[0]?.accessionNo === null);
}
check("more than the cap is one problem, nothing read", (() => { const r = readCatalogue(Array.from({ length: CATALOGUE_ROW_CAP + 1 }, () => row()), NOW); return r.rows.length === 0 && r.problems.length === 1 && r.problems[0]!.line === 0; })());
{
  const rows = readCatalogue(
    [
      row({ title: "Things Fall Apart", author: "Chinua Achebe", isbn: "9780385474542" }),
      row({ title: "things  fall apart", author: "CHINUA ACHEBE", isbn: "978-0-385-47454-2" }),
      row({ title: "Things Fall Apart", author: "Chinua Achebe", isbn: "9780141023380" }),
      row({ title: "Ghana Atlas", author: "" }),
    ],
    NOW,
  ).rows;
  const groups = groupIntoBooks(rows);
  check("the same title, author and ISBN (any case, any hyphens) is one book with two copies", groups.length === 3 && groups[0]!.copies.length === 2, JSON.stringify(groups.map((g) => g.copies.length)));
  check("a different ISBN is a different book", groups[1]!.copies.length === 1);
}

/* ───────────────────────────── who may reach it ───────────────────────────── */

console.log("\nWho may reach it");
check("the library is the office and the librarian", ["OWNER", "HEAD", "ASSISTANT_HEAD", "ADMIN", "IT_ADMIN", "LIBRARIAN"].every((r) => LIBRARY.includes(r as never)) && LIBRARY.length === OFFICE.length + 1);
check("not a teacher, a parent, the accountant or a house master", ["TEACHER", "PARENT", "ACCOUNTANT", "HOUSE_MASTER", "NURSE"].every((r) => !LIBRARY.includes(r as never)));
check("the loan rules are leadership's", JSON.stringify(LIBRARY_POLICY) === JSON.stringify(LEADERSHIP));
check("a librarian lands on the library, and the landing is a screen they may open", landingFor(["LIBRARIAN"]) === "/library" && LIBRARY.includes("LIBRARIAN"));
check("a head who also looks after the library keeps the whole app", landingFor(["HEAD", "LIBRARIAN"]) === "/dashboard" && !isLibrarianOnly(["HEAD", "LIBRARIAN"]));
check("a librarian who also teaches goes to the dashboard, as any two-role login does", landingFor(["LIBRARIAN", "TEACHER"]) === "/dashboard");
check("teachers, parents and the office land where they did", landingFor(["TEACHER"]) === "/assessments/sheet" && landingFor(["PARENT"]) === "/portal" && landingFor(["OWNER"]) === "/dashboard");
check("an empty role list is not a librarian", !isLibrarianOnly([]));
{
  const entry = NAV.flatMap((section) => section.items).find((item) => item.href === "/library");
  check("the rail has a Library entry for exactly the library roles", entry !== undefined && entry.icon === "library" && JSON.stringify(entry.roles) === JSON.stringify(LIBRARY));
}

/* ───────────────────────────── the code around it ───────────────────────────── */

console.log("\nThe code around it");
const engine = code("src/lib/library-engine.ts");
const actions = code("src/lib/library-actions.ts");
const data = code("src/lib/library-data.ts");
const rules = code("src/lib/library-rules.ts");

console.log("  — two desks, one copy");
{
  const lend = bodyOf(engine, "lend");
  const a = lend.indexOf("library:copy:");
  const b = lend.indexOf("library:borrower:");
  check("lending takes the copy's lock, then the person's, before it reads whether the copy is out", a > 0 && b > a && b < lend.indexOf("loans: { where: { returnedOn: null }") && b < lend.indexOf("lendCheck("));
  check("and writes the loan only after the check", lend.indexOf("lendCheck(") < lend.indexOf("tx.libraryLoan.create("));
  check("the loan is created in one place", (engine.match(/libraryLoan\.create\(/g) ?? []).length === 1);
  for (const name of ["returnBook", "renewLoan", "changeCopy"]) {
    const body = bodyOf(engine, name);
    const lock = body.indexOf("library:copy:");
    const firstWrite = Math.min(...["updateMany(", ".update("].map((w) => body.indexOf(w)).filter((i) => i >= 0));
    check(`${name} locks the copy before it writes`, lock > 0 && lock < firstWrite);
  }
  const closing = /libraryLoan\.updateMany\(\{\s*where:\s*\{[^}]*returnedOn:\s*null[^}]*\}/g;
  check("closing a loan is a conditional update (returnedOn: null in its where), so a second press changes nothing", (bodyOf(engine, "returnBook").match(closing) ?? []).length === 1 && (bodyOf(engine, "changeCopy").match(closing) ?? []).length === 1);
  check("renewing is conditional too, on the loan still being open and unchanged", /libraryLoan\.updateMany\(\{\s*where:\s*\{[^}]*returnedOn:\s*null[^}]*renewals:\s*loan\.renewals/.test(bodyOf(engine, "renewLoan")));
}

console.log("  — what is audited");
{
  const written = [...engine.matchAll(/action:\s*"([A-Za-z.]+)"/g)].map((m) => m[1]!).sort();
  check("the register's changes are audited: policy, book deleted, copy lost, copy withdrawn, import", JSON.stringify(written) === JSON.stringify(["library.book.delete", "library.copy.lost", "library.copy.withdraw", "library.import", "library.policy"]), written.join(", "));
  check("routine lending and returning is NOT audited (the loan row is the record; fifty a day would bury every payment)", !/library\.(lend|return|renew)/.test(engine + actions));
}

console.log("  — nothing here touches money");
{
  const files = [...walk(resolve(root, "src/app/(app)/library")), resolve(root, "src/lib/library-engine.ts"), resolve(root, "src/lib/library-data.ts"), resolve(root, "src/lib/library-rules.ts"), resolve(root, "src/lib/library-actions.ts")];
  const money = /\b(invoice|journalEntry|postJournal|ledger|payment|formatCedis|bookPayment)\b/i;
  const hits = files.filter((f) => money.test(code(f.replace(`${root}/`, "")))).map((f) => f.replace(`${root}/`, ""));
  check("no library file refers to an invoice, a payment or the ledger", hits.length === 0, hits.join(", "));
  check("overdue is never stored: no column, and nothing writes an OVERDUE outcome", !/outcome:\s*"OVERDUE"/.test(engine) && !/isOverdue|overdueAt/.test(readFileSync(resolve(root, "prisma/schema.prisma"), "utf8")));
}

console.log("  — the doors");
{
  const exported = [...actions.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]!);
  const guarded = (actions.match(/await requireRole\(/g) ?? []).length;
  const scoped = (actions.match(/setTenantContext\(auth\.tenant\)/g) ?? []).length;
  check(`every one of the ${exported.length} actions runs requireRole and sets the tenant context in its own frame`, guarded === exported.length && scoped === exported.length, `${exported.length} actions, ${guarded} requireRole, ${scoped} setTenantContext`);
  check("the rules are saved under the leadership list, and only that action", /savePolicyAction[\s\S]*?requireRole\(LIBRARY_POLICY\)/.test(actions) && (actions.match(/requireRole\(LIBRARY_POLICY\)/g) ?? []).length === 1);
  check("every other action is LIBRARY", (actions.match(/requireRole\(LIBRARY\)/g) ?? []).length === exported.length - 1);
  const pages = walk(resolve(root, "src/app/(app)/library")).filter((f) => f.endsWith("page.tsx"));
  const open = pages.filter((f) => !/requireRole\(LIBRARY\)/.test(code(f.replace(`${root}/`, ""))));
  check(`all ${pages.length} pages call requireRole(LIBRARY)`, pages.length === 8 && open.length === 0, open.join(", "));
  check("the engine is not a 'use server' module (every export of one is a public endpoint)", !/^\s*"use server"/m.test(engine) && !/^\s*"use server"/m.test(data) && !/^\s*"use server"/m.test(rules));
}

console.log("  — a person from a request is read back through the tenant client");
{
  const lend = bodyOf(engine, "lend");
  check("lending reads the pupil or the staff member with tx.student / tx.staff and this school's id before writing", /tx\.student\.findFirst\(\{\s*where:\s*\{\s*id:\s*args\.borrowerId,\s*schoolId:\s*actor\.schoolId/.test(lend) && /tx\.staff\.findFirst\(\{\s*where:\s*\{\s*id:\s*args\.borrowerId,\s*schoolId:\s*actor\.schoolId/.test(lend));
  const reads = ["returnBook", "renewLoan", "changeCopy", "deleteCopy", "updateBook", "deleteBook", "addCopies"].filter((n) => !new RegExp(`schoolId:\\s*actor\\.schoolId`).test(bodyOf(engine, n)));
  check("every other entry point scopes its reads and writes to the actor's school", reads.length === 0, reads.join(", "));
}

console.log("  — the schema, the migration, the merge, the portal");
{
  const schema = readFileSync(resolve(root, "prisma/schema.prisma"), "utf8");
  const model = (name: string) => new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`).exec(schema)?.[0] ?? "";
  check("Book, BookCopy and LibraryLoan each carry schoolId", ["Book", "BookCopy", "LibraryLoan"].every((m) => /\n\s+schoolId\s+String\b/.test(model(m))));
  check("a copy's number is unique within a school", /@@unique\(\[schoolId, accessionNo\]\)/.test(model("BookCopy")));
  const enumOf = (name: string) => (new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`).exec(schema)?.[1] ?? "").split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean);
  check("a loan ends RETURNED or LOST, and a copy is ACTIVE, LOST or WITHDRAWN", JSON.stringify(enumOf("LoanOutcome")) === JSON.stringify(["RETURNED", "LOST"]) && JSON.stringify(enumOf("CopyStatus")) === JSON.stringify(["ACTIVE", "LOST", "WITHDRAWN"]));
  check("history cascades from the borrower and the copy (Restrict would block tearing down a whole school)", !/onDelete: Restrict/.test(model("LibraryLoan")) && !/onDelete: Restrict/.test(model("BookCopy")));

  const migration = readFileSync(resolve(root, "prisma/migrations/20261105090000_library/migration.sql"), "utf8");
  check("the migration holds a loan to exactly one borrower, in the database", /LibraryLoan_one_borrower_check[\s\S]*?\("studentId" IS NOT NULL\)::int \+ \("staffId" IS NOT NULL\)::int\) = 1/.test(migration));
  check("and holds returned-on and outcome together", /LibraryLoan_closed_together_check[\s\S]*?\("returnedOn" IS NULL\) = \("outcome" IS NULL\)/.test(migration));
  check("the migration is additive: it creates and adds, and drops nothing", !/\bDROP\b/i.test(migration) && !/ALTER COLUMN/i.test(migration));

  const merge = code("src/lib/student-merge.ts");
  check("merging two pupils moves their library loans to the one kept", /libraryLoan\.updateMany\(\{\s*where:\s*\{\s*studentId:\s*removeId\s*\},\s*data:\s*\{\s*studentId:\s*keepId/.test(merge));

  const sequences = code("src/lib/sequences.ts");
  check("the accession sequence takes its shape from the one definition", /ACCESSION:\s*\{\s*prefix:\s*ACCESSION_SHAPE\.prefix,\s*padding:\s*ACCESSION_SHAPE\.padding/.test(sequences));

  const portal = code("src/app/(portal)/portal/[studentId]/page.tsx");
  const own = portal.indexOf("requireMyChild(studentId)");
  const loans = portal.indexOf("getStudentLoans(");
  check("the parent portal reads a child's books only after the child is proved to be theirs", own > 0 && loans > own && /getStudentLoans\(guardian\.schoolId,\s*studentId\)/.test(portal));
  const card = portal.slice(portal.indexOf("books.length > 0"));
  check("and shows a parent the title and the due date, not the library's numbers or anyone else's name", !/accessionNo|borrower|author/.test(card) && /book\.title/.test(card) && /dueOn/.test(card));

  const dash = code("src/app/(app)/dashboard/page.tsx");
  check("the dashboard sends a librarian-only login to the library", /isLibrarianOnly\(auth\.roles\)/.test(dash));
}

console.log("  — the settings are read");
for (const field of ["libraryPupilDays", "libraryStaffDays", "libraryPupilMax", "libraryStaffMax", "libraryBlockOverdue"]) {
  check(`${field} is read by the engine`, new RegExp(`\\.${field}\\b`).test(engine));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

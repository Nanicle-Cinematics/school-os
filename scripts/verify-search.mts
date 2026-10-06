/**
 * Prove global search finds what it should and shows nobody a door they cannot
 * open.
 *
 * The second half is the point. Search spans offices, so every hit has to link
 * somewhere the searcher's own roles admit them — a bursar handed a link to
 * /students/[id] (OFFICE only) gets bounced to the dashboard by the very guard
 * that protects it, and the search box looks broken rather than careful. The
 * first version of this file caught exactly that: receipts linked to the pupil.
 *
 *   npm run verify:search
 */

import type { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { setTenantContext } from "@/lib/tenant-context";
import { demoSchool } from "./fixture.mjs";
import { canSearch, search } from "@/lib/search-data";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const school = await demoSchool();
setTenantContext({ schoolId: school!.id, readOnly: false });
const id = school!.id;

const OWNER: Role[] = ["OWNER"];
const BURSAR: Role[] = ["ACCOUNTANT"];
const TEACHER: Role[] = ["TEACHER"];
const SECRETARY: Role[] = ["ADMIN"];

const student = await prisma.student.findFirst({ where: { deletedAt: null } });
const guardian = await prisma.guardian.findFirst({ where: { deletedAt: null } });
const payment = await prisma.payment.findFirst();

// ── Finding things ──────────────────────────────────────────────────────────
console.log("\nFinding");
const bySurname = await search(id, student!.lastName, OWNER);
check("a pupil by surname",
  bySurname.groups.some((g) => g.label === "Pupils" && g.hits.length > 0),
  `${bySurname.total} hits for "${student!.lastName}"`);

const byAdmission = await search(id, student!.admissionNo, OWNER);
check("a pupil by admission number",
  byAdmission.groups.some((g) => g.label === "Pupils"),
  student!.admissionNo);

const byPhone = await search(id, guardian!.phone, OWNER);
check("a guardian by phone", byPhone.groups.some((g) => g.label === "Guardians"), guardian!.phone);

const byReceipt = await search(id, payment!.receiptNo, OWNER);
check("a receipt by its number", byReceipt.groups.some((g) => g.label === "Receipts"),
  payment!.receiptNo);

const half = await search(id, student!.lastName.slice(0, 3), OWNER);
check("a partial name still matches", half.total > 0, `"${student!.lastName.slice(0, 3)}"`);

check("one character finds nothing", (await search(id, "a", OWNER)).total === 0);
check("blank finds nothing", (await search(id, "   ", OWNER)).total === 0);
check("nonsense finds nothing", (await search(id, "zzqqxx", OWNER)).total === 0);

// ── Who may search, and what they get ───────────────────────────────────────
console.log("\nScoping");
check("a teacher cannot search at all", !canSearch(TEACHER));
check("a bursar can", canSearch(BURSAR));
check("a secretary can", canSearch(SECRETARY));
check("a proprietor can", canSearch(OWNER));

const bursar = await search(id, student!.lastName, BURSAR);
const bursarGroups = bursar.groups.map((g) => g.label);
check("a bursar gets money, not the roll", !bursarGroups.some((l) => ["Pupils", "Guardians", "Staff"].includes(l)),
  bursarGroups.join(", ") || "nothing");

const secretary = await search(id, student!.lastName, SECRETARY);
const secretaryGroups = secretary.groups.map((g) => g.label);
check("a secretary gets the roll, not the money",
  !secretaryGroups.some((l) => ["Invoices", "Receipts"].includes(l)),
  secretaryGroups.join(", ") || "nothing");

const owner = await search(id, student!.lastName, OWNER);
check("a proprietor gets both", owner.groups.length >= bursar.groups.length,
  owner.groups.map((g) => g.label).join(", "));

// ── Every hit opens for the person who found it ─────────────────────────────
console.log("\nNo dead links");
const OFFICE_ONLY = [/^\/students\//, /^\/guardians\//, /^\/staff\//];
const FINANCE_ONLY = [/^\/invoices\//, /^\/payments/];

const bursarHrefs = bursar.groups.flatMap((g) => g.hits.map((h) => h.href));
check("a bursar is never linked to an OFFICE page",
  !bursarHrefs.some((href) => OFFICE_ONLY.some((re) => re.test(href))),
  bursarHrefs.join(", ") || "no hits");

const secretaryHrefs = secretary.groups.flatMap((g) => g.hits.map((h) => h.href));
check("a secretary is never linked to a FINANCE page",
  !secretaryHrefs.some((href) => FINANCE_ONLY.some((re) => re.test(href))),
  secretaryHrefs.join(", ") || "no hits");

check("every hit has a path and a title",
  owner.groups.every((g) => g.hits.every((h) => h.href.startsWith("/") && h.title.length > 0)));

console.log(`\n${passed} passed, ${failed} failed`);
await prisma.$disconnect();
if (failed > 0) process.exitCode = 1;

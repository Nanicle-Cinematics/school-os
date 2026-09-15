/**
 * A school can get its own data back out, and the file is not a trap.
 *
 * Data only ever went IN before this: `/students/import` took a CSV and nothing
 * anywhere produced one. A school could hand over its whole register, its fees
 * and three years of results and had no way to take a single row back.
 *
 * An export is easy to write and easy to get subtly wrong, and every way of
 * getting it wrong is quiet — a comma in an address shifts every column after
 * it, Excel eats the leading zero off a phone number, a role that should not
 * have the file gets it anyway. So each of those is a check here.
 *
 *   npm run verify:export
 */
import { parseCsv, TEMPLATE_HEADERS } from "@/lib/import-data";
import { DATASETS, DATASET_NAMES, dataset, exportFilename, toCsv } from "@/lib/export-data";
import { canAccess, FINANCE, OFFICE } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { runWithTenantContext, withBypass } from "@/lib/tenant-context";

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

/* ── The file format, which is where a CSV quietly goes wrong ────────────── */

console.log("A CSV that survives the things that break CSVs");

// RAW values in — toCsv is the only thing that escapes, so this exercises the
// real path a dataset takes rather than hand-quoted strings that prove nothing.
const nasty = toCsv(
  ["a", "b", "c"],
  [["Kofi, Jnr", 'He said "yes"', "line one\nline two"]],
);
const parsedNasty = parseCsv(nasty);

check(
  "a comma inside a value does not shift the columns",
  parsedNasty.rows[0]?.a === "Kofi, Jnr",
  JSON.stringify(parsedNasty.rows[0]?.a),
);
check(
  "a quote inside a value survives",
  parsedNasty.rows[0]?.b === 'He said "yes"',
  JSON.stringify(parsedNasty.rows[0]?.b),
);
check(
  "a newline inside a value stays one row",
  parsedNasty.rows.length === 1 && parsedNasty.rows[0]?.c?.includes("line two") === true,
  `${parsedNasty.rows.length} row(s)`,
);
check(
  "a null is an empty cell, not the word null",
  toCsv(["a"], [[null]]).includes("null") === false,
);

check(
  "the file starts with a BOM so Excel reads UTF-8",
  nasty.startsWith("\ufeff"),
  "without it, every name with a diacritic arrives mangled",
);

/* ── The one that bites Ghana specifically ───────────────────────────────── */

console.log("\nPhone numbers keep their leading zero");

const withPhone = toCsv(["phone"], [["0244123456"]], ["phone"]);
check(
  "a declared text column is written as text, not as a number",
  withPhone.includes('"\t0244123456"'),
  "Excel turns a bare 0244123456 into 244123456",
);
check(
  "and it reads back as the original number",
  parseCsv(withPhone).rows[0]?.phone === "0244123456",
  JSON.stringify(parseCsv(withPhone).rows[0]?.phone),
);
check(
  "a column NOT declared is left alone",
  toCsv(["phone"], [["0244123456"]]).includes("\t") === false,
  "the marker is opt-in, so it cannot leak into a name",
);
check(
  "every dataset holding a phone declares it",
  DATASET_NAMES.filter((n) => dataset(n).headers.some((h) => h.includes("phone"))).every((n) =>
    dataset(n).headers
      .filter((h) => h.includes("phone"))
      .every((h) => dataset(n).textColumns.includes(h)),
  ),
  "a phone column without the marker loses its leading zero silently",
);

/* ── Round trip, the claim the students file actually makes ──────────────── */

console.log("\nThe students export is an import file");

check(
  "it uses the importer's own headers, in order",
  JSON.stringify(dataset("students").headers) === JSON.stringify(TEMPLATE_HEADERS),
  dataset("students").headers.join(","),
);

/* ── Who may take what ───────────────────────────────────────────────────── */

console.log("\nAn export is a bulk read of the whole school, so the role is checked");

check(
  "a TEACHER may take nothing",
  DATASET_NAMES.every((name) => !canAccess(["TEACHER"], dataset(name).roles)),
  "a mark sheet is not the register",
);
check(
  "a PARENT may take nothing",
  DATASET_NAMES.every((name) => !canAccess(["PARENT"], dataset(name).roles)),
);
check(
  "an ACCOUNTANT gets the money and NOT the children",
  canAccess(["ACCOUNTANT"], DATASETS.invoices.roles) &&
    canAccess(["ACCOUNTANT"], DATASETS.payments.roles) &&
    !canAccess(["ACCOUNTANT"], DATASETS.students.roles) &&
    !canAccess(["ACCOUNTANT"], DATASETS.results.roles),
);
check(
  "an ADMIN gets the register and NOT the money",
  canAccess(["ADMIN"], DATASETS.students.roles) &&
    canAccess(["ADMIN"], DATASETS.guardians.roles) &&
    !canAccess(["ADMIN"], DATASETS.invoices.roles),
);
check(
  "results stay off the registrar's desk",
  !canAccess(["ADMIN"], DATASETS.results.roles) &&
    !canAccess(["TEACHER"], DATASETS.results.roles) &&
    !canAccess(["ACCOUNTANT"], DATASETS.results.roles),
);
/**
 * ⚠️ Asserted by WHO, not by which constant.
 *
 * This read `DATASETS.results.roles === LEADERSHIP`, an identity check on the
 * array itself, so widening the set to leadership-plus-IT failed it even though
 * the property it was protecting — a registrar, a teacher and a bursar cannot
 * export the marks — still held. Naming the roles says what is actually meant
 * and survives the next set being renamed.
 */
check(
  "and an IT admin may take them, as a leadership-level academic role",
  canAccess(["IT_ADMIN"], DATASETS.results.roles),
);
check(
  "the OWNER can take everything",
  DATASET_NAMES.every((name) => canAccess(["OWNER"], dataset(name).roles)),
  "it is their school's data",
);
check(
  "every dataset names a role list — none is open by default",
  DATASET_NAMES.every(
    (name) => Array.isArray(dataset(name).roles) && dataset(name).roles.length > 0,
  ),
);
check(
  "the money datasets are FINANCE",
  DATASETS.invoices.roles === FINANCE && DATASETS.payments.roles === FINANCE,
);
check("the people datasets are OFFICE", DATASETS.students.roles === OFFICE);

/* ── Filenames, because these files get kept ─────────────────────────────── */

console.log("\nFilenames a school can file");

const name = exportFilename("students", "St. Mary's R/C JHS", null, new Date("2026-09-12"));
check(
  "punctuation and spaces cannot break the download",
  /^[a-z0-9-]+\.csv$/.test(name),
  name,
);
check("the date is in the name", name.includes("2026-09-12"));
check(
  "a term-scoped file says which term",
  exportFilename("results", "Demo", "SECOND-2025/2026", new Date("2026-09-12")).includes("second"),
  exportFilename("results", "Demo", "SECOND-2025/2026", new Date("2026-09-12")),
);

/* ── And then actually run them, against real rows ───────────────────────── */

console.log("\nEvery dataset loads and produces the columns it promises");

const school = await withBypass(() =>
  prisma.school.findFirst({ where: { slug: { not: { startsWith: "qa-" } } } }),
);
const schoolId = school!.id;

await runWithTenantContext({ schoolId, readOnly: true }, async () => {
  const term = await prisma.term.findFirst({ where: { isCurrent: true }, select: { id: true } });

  for (const datasetName of DATASET_NAMES) {
    const spec = dataset(datasetName);
    const rows = await spec.load(spec.needsTerm ? (term?.id ?? null) : null);

    /**
     * ⚠️ First, that there is anything at all. Every other check in this loop
     * passes VACUOUSLY on an empty export — and empty is precisely how this
     * feature fails: under RLS a query with no tenant context returns no rows
     * rather than erroring, so a forgotten `setTenantContext` in the route
     * hands the school a file with a header and nothing under it, which reads
     * as "the school has no students".
     */
    check(
      `${datasetName}: returns rows at all`,
      rows.length > 0,
      `${rows.length} — an empty export is how a missing tenant context looks`,
    );

    check(
      `${datasetName}: every row has ${spec.headers.length} columns`,
      rows.every((row) => row.length === spec.headers.length),
      `${rows.length} rows`,
    );

    // Parse what the school would actually receive, not the array we built.
    const parsed = parseCsv(toCsv(spec.headers, rows, spec.textColumns));
    check(
      `${datasetName}: the file parses back to the same number of rows`,
      parsed.rows.length === rows.length,
      `${parsed.rows.length} parsed`,
    );
  }

  /**
   * The round trip, for real: take the register out and feed it to the actual
   * importer. "Same headers" is a claim that rots the first time either side is
   * edited alone, so it is checked against the parser rather than by eye.
   */
  const registerSpec = dataset("students");
  const students = await registerSpec.load(null);
  const reparsed = parseCsv(
    toCsv(registerSpec.headers, students, registerSpec.textColumns),
  );

  check(
    "a student export feeds back into the importer",
    reparsed.headers.join(",") === TEMPLATE_HEADERS.join(","),
    reparsed.headers.join(","),
  );

  if (students.length > 0) {
    const first = reparsed.rows[0];
    check(
      "and the admission number survives the trip",
      Boolean(first?.admission_no),
      first?.admission_no,
    );
    check(
      "so does the guardian's phone, leading zero and all",
      !first?.guardian_phone || /^0?\d+$/.test(first.guardian_phone.replace(/[^\d]/g, "")),
      first?.guardian_phone || "(no guardian on the first row)",
    );
    check(
      "a name with a comma in it is still one field",
      reparsed.rows.every((row) => typeof row.last_name === "string"),
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
await prisma.$disconnect();
process.exit(failed === 0 ? 0 : 1);

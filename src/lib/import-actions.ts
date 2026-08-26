"use server";

import { revalidatePath } from "next/cache";
import type { GuardianRelationship } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { nextNumber, takenProbes } from "@/lib/sequences";
import { writeAudit } from "@/lib/audit";
import { normalisePhone } from "@/lib/sms-shared";
import { checkImport, type RowCheck } from "@/lib/import-data";

export type ReportRow = {
  line: number;
  name: string;
  className: string;
  admissionNo: string | null;
  guardian: string | null;
  errors: string[];
  warnings: string[];
};

export type ImportState = {
  error?: string;
  ok?: string;
  csv?: string;
  report?: { ready: number; blocked: number; rows: ReportRow[] };
};

const RELATIONSHIPS = [
  "FATHER",
  "MOTHER",
  "GRANDPARENT",
  "UNCLE",
  "AUNT",
  "SIBLING",
  "GUARDIAN",
  "OTHER",
];

/** How many students are written per transaction. */
const CHUNK = 20;

function toReportRow(check: RowCheck): ReportRow {
  return {
    line: check.line,
    name: [check.firstName, check.lastName].filter(Boolean).join(" ") || "(no name)",
    className: check.className,
    admissionNo: check.admissionNo,
    guardian: check.guardian ? `${check.guardian.firstName} ${check.guardian.lastName}` : null,
    errors: check.errors,
    warnings: check.warnings,
  };
}

/** Read the pasted text or the uploaded file, whichever the office used. */
async function readCsv(formData: FormData): Promise<string> {
  const file = formData.get("file");
  if (file && typeof file !== "string" && file.size > 0) {
    return file.text();
  }
  return String(formData.get("csv") ?? "");
}

export async function previewImport(
  _prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const csv = await readCsv(formData);
  if (!csv.trim()) {
    return { error: "Paste the spreadsheet, or choose a CSV file." };
  }

  const { checks, ready, blocked } = await checkImport(csv);
  if (checks.length === 0) {
    return { error: "No rows found. The first line must be the column headings." };
  }

  return {
    csv,
    report: { ready, blocked, rows: checks.map(toReportRow) },
    ok: `${checks.length} rows read — ${ready} ready, ${blocked} with problems. Nothing has been saved yet.`,
  };
}

/**
 * Write the rows that passed.
 *
 * Re-checks from the CSV rather than trusting a preview the browser sends back,
 * and writes in chunks: a six-hundred-row single transaction would outlive any
 * sane timeout on this link, and a chunk that fails leaves the earlier ones
 * saved rather than losing the whole afternoon's work.
 */
export async function commitImport(
  _prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const csv = await readCsv(formData);
  if (!csv.trim()) {
    return { error: "Nothing to import." };
  }

  const { checks } = await checkImport(csv);
  const usable = checks.filter((check) => check.errors.length === 0);
  if (usable.length === 0) {
    return { error: "Every row has a problem — fix the file and preview it again." };
  }

  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });

  let created = 0;
  let guardiansCreated = 0;
  let guardiansReused = 0;

  // Every guardian's phone, read once. Doing this per row would be a query per
  // child, and the whole point of the screen is six hundred of them at a time.
  const guardianByPhone = new Map<string, string>();
  for (const guardian of await prisma.guardian.findMany({
    where: { deletedAt: null },
    select: { id: true, phone: true },
  })) {
    const key = normalisePhone(guardian.phone);
    if (key && !guardianByPhone.has(key)) {
      guardianByPhone.set(key, guardian.id);
    }
  }

  for (let start = 0; start < usable.length; start += CHUNK) {
    const chunk = usable.slice(start, start + CHUNK);

    await tenantTransaction(auth.schoolId, async (tx) => {
        for (const row of chunk) {
          const admissionNo =
            row.admissionNo ??
            (await nextNumber(tx, auth.schoolId, "ADMISSION", takenProbes.admission(tx, auth.schoolId)));

          const student = await tx.student.create({
            data: {
              schoolId: auth.schoolId,
              admissionNo,
              firstName: row.firstName,
              middleName: row.middleName,
              lastName: row.lastName,
              gender: row.gender as "MALE" | "FEMALE",
              dateOfBirth: row.dateOfBirth,
              residency: row.residency,
              houseId: row.houseId,
              status: "ACTIVE",
              admissionDate: new Date(),
              currentClassGroupId: row.classGroupId,
            },
          });

          if (row.classGroupId && year) {
            await tx.enrollment.create({
              data: {
                schoolId: auth.schoolId,
                studentId: student.id,
                academicYearId: year.id,
                classGroupId: row.classGroupId,
                status: "ACTIVE",
              },
            });
          }

          if (row.guardian) {
            // Siblings share a parent: match on the normalised phone so a family
            // of four does not become four copies of the same mother.
            const phone = normalisePhone(row.guardian.phone) as string;

            let guardianId = guardianByPhone.get(phone);
            if (guardianId) {
              guardiansReused += 1;
            } else {
              const guardian = await tx.guardian.create({
                data: {
                  schoolId: auth.schoolId,
                  firstName: row.guardian.firstName,
                  lastName: row.guardian.lastName,
                  phone: row.guardian.phone,
                },
              });
              guardianId = guardian.id;
              guardianByPhone.set(phone, guardianId);
              guardiansCreated += 1;
            }

            const relationship = RELATIONSHIPS.includes(row.guardian.relationship)
              ? (row.guardian.relationship as GuardianRelationship)
              : "GUARDIAN";

            await tx.studentGuardian.create({
              data: {
                schoolId: auth.schoolId,
                studentId: student.id,
                guardianId,
                relationship,
                isPrimary: true,
                receivesBills: true,
                receivesReports: true,
              },
            });
          }

          created += 1;
        }
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "student.import",
      entity: "School",
      entityId: auth.schoolId,
      after: { created, guardiansCreated, guardiansReused, skipped: checks.length - usable.length },
    });
  });

  revalidatePath("/students");
  revalidatePath("/guardians");
  revalidatePath("/dashboard");

  const skipped = checks.length - usable.length;
  return {
    ok: `Imported ${created} students${
      guardiansCreated ? `, created ${guardiansCreated} guardians` : ""
    }${guardiansReused ? `, linked ${guardiansReused} to an existing guardian` : ""}${
      skipped ? `. ${skipped} rows were skipped — fix them and import again.` : "."
    }`,
  };
}

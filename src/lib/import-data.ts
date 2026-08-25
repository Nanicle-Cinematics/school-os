import "server-only";

import { prisma } from "@/lib/prisma";
import { normalisePhone } from "@/lib/sms-shared";

// Queries are sequential rather than Promise.all — see the note in class-data.ts:
// the pool holds one connection, so a fan-out only queues and then times out.

export type ParsedRow = Record<string, string>;

export type RowCheck = {
  line: number;
  raw: ParsedRow;
  firstName: string;
  lastName: string;
  middleName: string | null;
  gender: "MALE" | "FEMALE" | null;
  dateOfBirth: Date | null;
  admissionNo: string | null;
  classGroupId: string | null;
  className: string;
  houseId: string | null;
  residency: "DAY" | "BOARDING";
  guardian: { firstName: string; lastName: string; phone: string; relationship: string } | null;
  errors: string[];
  warnings: string[];
};

/**
 * A deliberately small CSV reader.
 *
 * Handles what Excel actually emits — quoted fields containing commas, doubled
 * quotes, CRLF, a UTF-8 BOM — and nothing else. A dependency for this would be
 * another thing to install over a very slow link.
 */
export function parseCsv(text: string): { headers: string[]; rows: ParsedRow[] } {
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  if (!clean) {
    return { headers: [], rows: [] };
  }

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];
    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  record.push(field);
  records.push(record);

  const [head, ...body] = records;
  // Headers are normalised so "First Name", "first_name" and "firstname" all land.
  const headers = head.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));

  const rows = body
    .filter((cells) => cells.some((cell) => cell.trim() !== ""))
    .map((cells) => {
      const row: ParsedRow = {};
      headers.forEach((header, index) => {
        row[header] = (cells[index] ?? "").trim();
      });
      return row;
    });

  return { headers, rows };
}

function pick(row: ParsedRow, ...names: string[]) {
  for (const name of names) {
    if (row[name]) {
      return row[name];
    }
  }
  return "";
}

function readGender(value: string): "MALE" | "FEMALE" | null {
  const v = value.trim().toLowerCase();
  if (["m", "male", "boy"].includes(v)) return "MALE";
  if (["f", "female", "girl"].includes(v)) return "FEMALE";
  return null;
}

function readDate(value: string): Date | null {
  const v = value.trim();
  if (!v) return null;
  // dd/mm/yyyy is what a Ghanaian office writes; ISO is what Excel exports.
  const dmy = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  const date = dmy
    ? new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]))
    : new Date(v);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const TEMPLATE_HEADERS = [
  "first_name",
  "middle_name",
  "last_name",
  "gender",
  "date_of_birth",
  "class",
  "admission_no",
  "residency",
  "house",
  "guardian_name",
  "guardian_phone",
  "guardian_relationship",
];

/** Check every row against the school's real classes, houses and admission numbers. */
export async function checkImport(text: string): Promise<{
  headers: string[];
  checks: RowCheck[];
  ready: number;
  blocked: number;
}> {
  const { headers, rows } = parseCsv(text);

  const classGroups = await prisma.classGroup.findMany({
    select: { id: true, name: true, level: { select: { name: true } } },
  });
  const houses = await prisma.house.findMany({ select: { id: true, name: true } });
  const existing = await prisma.student.findMany({
    where: { deletedAt: null },
    select: { admissionNo: true },
  });

  // "Basic 5 A", "basic 5 a" and (when unambiguous) plain "Basic 5" all resolve.
  const classByLabel = new Map<string, string>();
  const levelCounts = new Map<string, number>();
  for (const group of classGroups) {
    classByLabel.set(`${group.level.name} ${group.name}`.toLowerCase(), group.id);
    levelCounts.set(group.level.name.toLowerCase(), (levelCounts.get(group.level.name.toLowerCase()) ?? 0) + 1);
  }
  for (const group of classGroups) {
    const levelKey = group.level.name.toLowerCase();
    if (levelCounts.get(levelKey) === 1) {
      classByLabel.set(levelKey, group.id);
    }
  }

  const houseByName = new Map(houses.map((house) => [house.name.toLowerCase(), house.id]));
  const takenAdmission = new Set(existing.map((student) => student.admissionNo.toLowerCase()));
  const seenInFile = new Set<string>();

  const checks: RowCheck[] = rows.map((raw, index) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    const firstName = pick(raw, "first_name", "firstname", "given_name");
    const lastName = pick(raw, "last_name", "lastname", "surname");
    const middleName = pick(raw, "middle_name", "middlename") || null;
    const gender = readGender(pick(raw, "gender", "sex"));
    const dateOfBirth = readDate(pick(raw, "date_of_birth", "dob", "birth_date"));
    const className = pick(raw, "class", "class_name", "classroom");
    const admissionRaw = pick(raw, "admission_no", "admission_number", "admissionno");
    const houseName = pick(raw, "house");
    const residencyRaw = pick(raw, "residency", "boarding").toLowerCase();

    if (!firstName) errors.push("no first name");
    if (!lastName) errors.push("no surname");
    if (!gender) errors.push("gender must be M or F");

    let classGroupId: string | null = null;
    if (!className) {
      warnings.push("no class — will be admitted unplaced");
    } else {
      classGroupId = classByLabel.get(className.trim().toLowerCase()) ?? null;
      if (!classGroupId) {
        errors.push(`no class called "${className}"`);
      }
    }

    let admissionNo: string | null = null;
    if (admissionRaw) {
      const key = admissionRaw.toLowerCase();
      if (takenAdmission.has(key)) {
        errors.push(`admission number ${admissionRaw} already exists`);
      } else if (seenInFile.has(key)) {
        errors.push(`admission number ${admissionRaw} appears twice in this file`);
      } else {
        seenInFile.add(key);
        admissionNo = admissionRaw;
      }
    }

    let houseId: string | null = null;
    if (houseName) {
      houseId = houseByName.get(houseName.trim().toLowerCase()) ?? null;
      if (!houseId) warnings.push(`no house called "${houseName}" — left blank`);
    }

    const guardianName = pick(raw, "guardian_name", "parent_name", "guardian");
    const guardianPhone = pick(raw, "guardian_phone", "parent_phone", "phone");
    let guardian: RowCheck["guardian"] = null;
    if (guardianName || guardianPhone) {
      if (!guardianName) {
        warnings.push("guardian phone without a name — guardian skipped");
      } else if (!normalisePhone(guardianPhone)) {
        warnings.push("guardian phone is not a Ghanaian mobile — guardian skipped");
      } else {
        const parts = guardianName.trim().split(/\s+/);
        guardian = {
          firstName: parts[0],
          lastName: parts.slice(1).join(" ") || parts[0],
          phone: guardianPhone.trim(),
          relationship: pick(raw, "guardian_relationship", "relationship").toUpperCase() || "GUARDIAN",
        };
      }
    } else {
      warnings.push("no guardian — nobody will receive bills or results");
    }

    return {
      line: index + 2, // +1 for the header, +1 because humans count from one
      raw,
      firstName,
      lastName,
      middleName,
      gender,
      dateOfBirth,
      admissionNo,
      classGroupId,
      className,
      houseId,
      residency: residencyRaw.startsWith("board") ? "BOARDING" : "DAY",
      guardian,
      errors,
      warnings,
    };
  });

  return {
    headers,
    checks,
    ready: checks.filter((check) => check.errors.length === 0).length,
    blocked: checks.filter((check) => check.errors.length > 0).length,
  };
}

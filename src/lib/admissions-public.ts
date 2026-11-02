import "server-only";

import { prisma } from "@/lib/prisma";
import { runWithTenantContext, withBypass } from "@/lib/tenant-context";
import { takeAttempt } from "@/lib/rate-limit";
import { subscriptionState } from "@/lib/subscription";
import { createApplication } from "@/lib/admissions-engine";
import {
  ONLINE_PER_ADDRESS_PER_HOUR,
  ONLINE_PER_DAY,
  TRAP_FIELD,
  readApplication,
  startableYears,
} from "@/lib/admissions-rules";

/**
 * The application form a parent fills in with no login.
 *
 * Everything here runs for a stranger, so it is built to be cheap to refuse and unwilling to explain:
 *
 * - A school with no form, a school whose form is closed, a school that has lapsed to read-only and a slug
 *   that is not a school all answer the SAME "not found". The page cannot be used to ask which schools
 *   exist or which have switched admissions on.
 * - It is public and costs database lookups, so the route puts all of it inside `publicLookup`'s budget
 *   (two at once, a short queue, the rest turned away with a 503).
 * - It writes one table. Spam is met three ways: a field no person sees (a script that fills it is told it
 *   worked and nothing is saved), a limit per address per hour, and a ceiling on online applications per
 *   school per day, so a flood fills a bucket and not the table.
 * - It never says an application for a named child already exists. That would let anyone ask whether a
 *   child is applying; duplicates are flagged to the OFFICE instead (`lookAlikes`).
 *
 * The school is found by its URL key under `withBypass` (a stranger has no school yet), and everything after
 * runs inside that school's own context, with the same row security as any other request.
 */

const looksLikeSlug = (value: string) => /^[a-z0-9][a-z0-9-]{1,60}$/.test(value);
export { looksLikeSlug };

const DAY = 86_400_000;

type OpenSchool = { id: string; name: string; motto: string | null; note: string | null };

async function openSchool(slug: string): Promise<OpenSchool | null> {
  if (!looksLikeSlug(slug)) return null;
  const school = await withBypass(() =>
    prisma.school.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        motto: true,
        plan: true,
        subscriptionStatus: true,
        trialEndsAt: true,
        paidUntil: true,
        settings: { select: { applicationsOpen: true, applicationsNote: true } },
      },
    }),
  );
  if (!school || !school.settings?.applicationsOpen) return null;
  // A school that has lapsed to read-only cannot write, and a form that took applications it could not
  // keep would be worse than a closed one.
  if (subscriptionState(school).readOnly) return null;
  return { id: school.id, name: school.name, motto: school.motto, note: school.settings.applicationsNote };
}

export type PublicForm = {
  school: { name: string; motto: string | null };
  note: string | null;
  levels: { id: string; name: string }[];
  years: { id: string; name: string; isCurrent: boolean }[];
};

/** What the public page renders, or null for "there is no form here". */
export async function getPublicForm(slug: string): Promise<PublicForm | null> {
  const school = await openSchool(slug);
  if (!school) return null;
  return runWithTenantContext({ schoolId: school.id }, async () => {
    const levels = await prisma.level.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } });
    const years = await prisma.academicYear.findMany({
      orderBy: { startDate: "asc" },
      select: { id: true, name: true, isCurrent: true, endDate: true },
    });
    const open = startableYears(years).map(({ id, name, isCurrent }) => ({ id, name, isCurrent }));
    if (levels.length === 0 || open.length === 0) return null;
    return { school: { name: school.name, motto: school.motto }, note: school.note, levels, years: open };
  });
}

export type SubmitOutcome =
  | { status: 200; reference: string }
  | { status: 400 | 404 | 429; error: string };

const NOT_FOUND: SubmitOutcome = { status: 404, error: "This application form is not available." };

export async function submitPublicApplication(slug: string, body: unknown, address: string): Promise<SubmitOutcome> {
  const school = await openSchool(slug);
  if (!school) return NOT_FOUND;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, error: "That was not an application." };
  }
  const raw = body as Record<string, unknown>;

  // The trap: told it worked, nothing saved, nothing counted.
  if (typeof raw[TRAP_FIELD] === "string" && raw[TRAP_FIELD].trim() !== "") {
    return { status: 200, reference: "APP-0000" };
  }

  const read = readApplication(raw);
  if (!read.ok) return { status: 400, error: read.error };

  if (!(await takeAttempt(`apply:${address}`, ONLINE_PER_ADDRESS_PER_HOUR, 60 * 60 * 1000))) {
    return { status: 429, error: "Too many applications from this connection. Please try again later, or ask the school office." };
  }

  return runWithTenantContext({ schoolId: school.id }, async () => {
    const today = await prisma.application.count({
      where: { schoolId: school.id, source: "ONLINE", createdAt: { gte: new Date(Date.now() - DAY) } },
    });
    if (today >= ONLINE_PER_DAY) {
      return { status: 429, error: "The school has received a very large number of applications today. Please try again tomorrow, or ask the school office." } as SubmitOutcome;
    }
    const made = await createApplication({ schoolId: school.id, userId: null }, read.value, "ONLINE");
    if ("error" in made) return { status: 400, error: made.error } as SubmitOutcome;
    return { status: 200, reference: made.reference } as SubmitOutcome;
  });
}

import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { TEMPLATE_HEADERS } from "@/lib/import-data";
import { Alert, Card } from "../../ui";
import { ImportForm } from "./import-form";

export const metadata: Metadata = { title: "Import students · School OS" };

export default async function ImportPage() {
  await requireRole(OFFICE);

  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });
  const sample = await prisma.classGroup.findFirst({
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
    select: { name: true, level: { select: { name: true } } },
  });
  const houses = await prisma.house.findMany({ select: { name: true }, take: 1 });

  const example = sample ? `${sample.level.name} ${sample.name}` : "Basic 1 A";
  const template = [
    TEMPLATE_HEADERS.join(","),
    `Ama,Serwaa,Mensah,F,12/04/2015,${example},,day,${houses[0]?.name ?? ""},Kofi Mensah,0244123456,FATHER`,
  ].join("\n");

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <Link href="/students" className="text-sm text-slate-500 hover:text-slate-900">
          ← Students
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Import students</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Bring a whole school in from a spreadsheet. Nothing is saved until you have seen the
          check.
        </p>
      </div>

      {!year ? (
        <Alert tone="error">
          No academic year is marked current, so imported students can be admitted but not placed on
          a roster. Set one under{" "}
          <Link href="/settings/terms" className="underline">
            Years and terms
          </Link>{" "}
          first.
        </Alert>
      ) : null}

      <Card title="Columns">
        <div className="space-y-2 p-4 text-sm text-slate-600">
          <p>
            The first line must be the headings. Only{" "}
            <code className="rounded bg-slate-100 px-1 text-xs">first_name</code>,{" "}
            <code className="rounded bg-slate-100 px-1 text-xs">last_name</code> and{" "}
            <code className="rounded bg-slate-100 px-1 text-xs">gender</code> are required;
            everything else can be blank.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-600">
            {template}
          </pre>
          <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">
            <li>
              <strong>class</strong> must match a class you already have, written as
              &ldquo;{example}&rdquo;. If a level has only one class, its name alone is enough.
            </li>
            <li>
              <strong>admission_no</strong> can be left blank and one is allocated; supply it to keep
              the numbers a school already uses.
            </li>
            <li>
              <strong>gender</strong> accepts M, F, male or female. Dates accept 12/04/2015 or
              2015-04-12.
            </li>
            <li>
              Children who share a <strong>guardian_phone</strong> are linked to the same guardian,
              so a family of four does not become four copies of the same mother.
            </li>
          </ul>
        </div>
      </Card>

      <Card title="The file">
        <ImportForm template={template} />
      </Card>
    </div>
  );
}

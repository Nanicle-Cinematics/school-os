import type { Metadata } from "next";
import Link from "next/link";
import { ClipboardList, Globe, Plus } from "lucide-react";
import type { ApplicationStatus } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { ADMISSIONS, ADMISSIONS_FORM, canAccess } from "@/lib/permissions";
import { STATUS_LABEL, STATUS_ORDER } from "@/lib/admissions-rules";
import {
  getAdmissionsSettings,
  getApplications,
  getApplyOptions,
  getSeatTable,
  getStatusCounts,
} from "@/lib/admissions-data";
import { Avatar, Card, PageHeader, filterClass } from "../ui";
import { ButtonLink, DataTable, Row, cellClass, type Column } from "../primitives";
import { ApplicationBadge } from "./application-badge";
import { FormPanel } from "./form-panel";

export const metadata: Metadata = { title: "Admissions · School OS" };
export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { label: "Child" },
  { label: "Applying for" },
  { label: "Parent", hideBelow: "md" },
  { label: "Test", hideBelow: "lg" },
  { label: "Step" },
];

const SEAT_COLUMNS: Column[] = [
  { label: "Class" },
  { label: "Places", numeric: true },
  { label: "Enrolled", numeric: true, hideBelow: "sm" },
  { label: "Offered", numeric: true },
  { label: "Left", numeric: true },
  { label: "Waiting", numeric: true, hideBelow: "sm" },
];

const day = (value: Date | null) =>
  value ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";

export default async function AdmissionsPage({ searchParams }: PageProps<"/admissions">) {
  const auth = await requireRole(ADMISSIONS);
  const params = await searchParams;
  const text = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : "");

  const { levels, years } = await getApplyOptions();
  const yearId = text("year") || years.find((y) => y.isCurrent)?.id || years[0]?.id || "";
  const requested = text("status");
  const status: ApplicationStatus | "open" | "" =
    requested === "all" ? "" : STATUS_ORDER.includes(requested as ApplicationStatus) ? (requested as ApplicationStatus) : "open";
  const levelId = text("level");
  const q = text("q").trim();

  const settings = await getAdmissionsSettings(auth.schoolId);
  const counts = await getStatusCounts(auth.schoolId);
  const seatRows = yearId ? await getSeatTable(auth.schoolId, yearId) : [];
  const { rows, truncated } = await getApplications(auth.schoolId, {
    status: status || undefined,
    levelId: levelId || undefined,
    academicYearId: yearId || undefined,
    q,
  });

  const canForm = canAccess(auth.roles, ADMISSIONS_FORM);
  const link = `${process.env.APP_URL ?? ""}/apply/${settings.slug}`;
  const yearName = years.find((y) => y.id === yearId)?.name ?? "";
  const open = counts.APPLIED + counts.TESTING + counts.WAITLISTED + counts.OFFERED + counts.ACCEPTED;
  const filtered = Boolean(q || levelId || requested);

  const href = (next: Record<string, string>) => {
    const query = new URLSearchParams();
    if (yearId) query.set("year", yearId);
    for (const [key, value] of Object.entries(next)) if (value) query.set(key, value);
    return `/admissions?${query.toString()}`;
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Admissions"
        subtitle={open ? `${open} application${open === 1 ? "" : "s"} still being decided` : "From first enquiry to a place on the roll."}
        action={
          <ButtonLink href="/admissions/new" variant="primary" icon={Plus}>
            New application
          </ButtonLink>
        }
      />

      <Card title="Online application form">
        {canForm ? (
          <FormPanel link={link} open={settings.open} note={settings.note} />
        ) : (
          <p className="px-4.5 py-4 text-sm text-slate-600">
            The online form is <strong>{settings.open ? "open" : "closed"}</strong>. A head teacher or the proprietor opens and closes it.
            {settings.open ? ` Link to share: ${link}` : ""}
          </p>
        )}
      </Card>

      <div className="flex flex-wrap gap-2">
        {STATUS_ORDER.map((s) => (
          <Link
            key={s}
            href={href({ status: s, level: levelId, q })}
            aria-current={status === s ? "true" : undefined}
            className={`rounded-full border px-3 py-1.5 text-sm transition ${
              status === s ? "border-brand-600 bg-brand-600 text-white" : "border-hairline bg-surface text-slate-700 hover:bg-slate-100"
            }`}
          >
            {STATUS_LABEL[s]} <span className="font-semibold tabular-nums">{counts[s]}</span>
          </Link>
        ))}
      </div>

      <form className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="status" value={requested} />
        <input type="search" name="q" defaultValue={q} placeholder="Name, reference or phone" className={`${filterClass} w-56`} />
        <select name="level" defaultValue={levelId} className={`${filterClass} w-44`} aria-label="Class applying for">
          <option value="">All classes</option>
          {levels.map((level) => (
            <option key={level.id} value={level.id}>
              {level.name}
            </option>
          ))}
        </select>
        <select name="year" defaultValue={yearId} className={`${filterClass} w-36`} aria-label="Starting in">
          {years.map((year) => (
            <option key={year.id} value={year.id}>
              {year.name}
            </option>
          ))}
        </select>
        <button type="submit" className="whitespace-nowrap rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
          Filter
        </button>
        {filtered ? (
          <Link href={href({})} className="text-sm text-slate-500 hover:text-slate-900">
            Clear
          </Link>
        ) : null}
        <Link href={href({ status: "all", level: levelId, q })} className="ml-auto text-sm text-slate-500 hover:text-slate-900">
          Show every step
        </Link>
      </form>

      <DataTable
        columns={COLUMNS}
        empty={{
          icon: ClipboardList,
          title: filtered
            ? "No application matches that. Try another step or clear the filter."
            : "No applications yet. Record one for a walk-in, or open the online form and share the link.",
          action: filtered ? undefined : { label: "New application", href: "/admissions/new" },
        }}
      >
        {rows.map((row) => (
          <Row key={row.id}>
            <td className={cellClass(COLUMNS[0])}>
              <Link href={`/admissions/${row.id}`} className="group flex items-center gap-3">
                <Avatar firstName={row.firstName} lastName={row.lastName} />
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-slate-900 group-hover:underline">
                    {row.lastName}, {row.firstName}
                  </span>
                  <span className="block font-mono text-[11px] text-slate-400">
                    {row.reference}
                    {row.source === "ONLINE" ? " · online" : ""}
                    {row.lookAlikes > 0 ? " · possible duplicate" : ""}
                  </span>
                </span>
              </Link>
            </td>
            <td className={`${cellClass(COLUMNS[1])} whitespace-nowrap text-slate-600`}>
              {row.level.name}
              <span className="block text-xs text-slate-400">{row.academicYear.name}</span>
            </td>
            <td className={`${cellClass(COLUMNS[2])} text-slate-600`}>
              {row.guardianName}
              <span className="ml-2 text-xs text-slate-400">{row.guardianPhone}</span>
            </td>
            <td className={`${cellClass(COLUMNS[3])} whitespace-nowrap text-slate-600`}>
              {row.testScore !== null ? `${Number(row.testScore)}/100` : row.testedOn ? day(row.testedOn) : "—"}
            </td>
            <td className={cellClass(COLUMNS[4])}>
              <ApplicationBadge status={row.status} lapsed={row.lapsed} />
            </td>
          </Row>
        ))}
      </DataTable>
      {truncated ? <p className="text-sm text-slate-500">Showing the newest 400. Narrow the filter to see the rest.</p> : null}

      {yearId ? (
        <>
          <h2 className="px-0.5 pt-2 font-heading text-lg text-slate-900">Places for {yearName}</h2>
          <DataTable
            columns={SEAT_COLUMNS}
            empty={{ icon: Globe, title: "Add the school's classes under Settings → School structure to see places here." }}
          >
            {seatRows.map((row) => (
              <Row key={row.levelId}>
                <td className={`${cellClass(SEAT_COLUMNS[0])} font-semibold text-slate-900`}>{row.levelName}</td>
                <td className={cellClass(SEAT_COLUMNS[1])}>{row.seats.limited ? row.seats.capacity : "No limit"}</td>
                <td className={cellClass(SEAT_COLUMNS[2])}>{row.seats.enrolled}</td>
                <td className={cellClass(SEAT_COLUMNS[3])}>{row.seats.held}</td>
                <td className={`${cellClass(SEAT_COLUMNS[4])} font-semibold ${row.seats.limited && row.seats.left <= 0 ? "text-danger-ink" : "text-slate-900"}`}>
                  {row.seats.limited ? row.seats.left : "—"}
                </td>
                <td className={cellClass(SEAT_COLUMNS[5])}>{row.waiting}</td>
              </Row>
            ))}
          </DataTable>
        </>
      ) : null}
    </div>
  );
}

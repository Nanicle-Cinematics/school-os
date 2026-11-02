import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ApplicationStatus } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { ADMISSIONS } from "@/lib/permissions";
import { getApplicationDetail } from "@/lib/admissions-data";
import { RELATIONSHIP_OPTIONS } from "@/app/apply/application-fields";
import { STATUS_LABEL, isSettled, movesFrom } from "@/lib/admissions-rules";
import { Alert, Card, PageHeader } from "../../ui";
import { ButtonLink } from "../../primitives";
import { ApplicationBadge } from "../application-badge";
import { AdmitForm, DeleteForm, MoveForm, TestForm } from "./detail-actions";

export const metadata: Metadata = { title: "Application · School OS" };
export const dynamic = "force-dynamic";

const day = (value: Date | null) =>
  value ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "—";
const iso = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : "");

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children || "—"}</dd>
    </div>
  );
}

/** Words for the step a button takes, which depend on where the application is now. */
function moveLabel(from: ApplicationStatus, to: ApplicationStatus): string {
  if (to === "APPLIED") return from === "REJECTED" || from === "WITHDRAWN" ? "Reopen this application" : "Back to applied";
  if (to === "TESTING") return "Send for the test or interview";
  if (to === "WAITLISTED") return "Put on the waiting list";
  if (to === "OFFERED") return from === "ACCEPTED" ? "Back to offered" : "Offer a place";
  if (to === "ACCEPTED") return "The family has accepted";
  if (to === "REJECTED") return "Do not offer a place";
  return "The family has withdrawn";
}

export default async function ApplicationPage({ params }: PageProps<"/admissions/[id]">) {
  const auth = await requireRole(ADMISSIONS);
  const { id } = await params;
  const detail = await getApplicationDetail(auth.schoolId, id);
  if (!detail) notFound();

  const { application: a, seats, classes, sameApplications, samePupils, lapsed } = detail;
  const settled = isSettled(a.status);
  const relationship = RELATIONSHIP_OPTIONS.find(([key]) => key === a.guardianRelationship)?.[1] ?? "Guardian";
  const moves = movesFrom(a.status);
  const yearIsCurrent = a.academicYear.isCurrent;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={`${a.firstName} ${a.lastName}`}
        subtitle={`${a.reference} · ${a.level.name}, ${a.academicYear.name}${a.source === "ONLINE" ? " · applied online" : ""}`}
        action={
          settled ? undefined : (
            <ButtonLink href={`/admissions/${a.id}/edit`} variant="secondary">
              Edit details
            </ButtonLink>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <ApplicationBadge status={a.status} lapsed={lapsed} />
        {a.status === "OFFERED" && a.offerExpiresOn ? (
          <span className={`text-sm ${lapsed ? "text-danger-ink" : "text-slate-600"}`}>
            {lapsed ? "The offer lapsed on" : "Offer valid until"} {day(a.offerExpiresOn)}
          </span>
        ) : null}
        {a.decisionNote ? <span className="text-sm text-slate-600">“{a.decisionNote}”</span> : null}
      </div>

      {sameApplications.length > 0 || samePupils.length > 0 ? (
        <Alert tone="error">
          This may be a child who is already here:{" "}
          {sameApplications.map((o, i) => (
            <span key={o.id}>
              {i > 0 ? ", " : ""}
              <Link href={`/admissions/${o.id}`} className="font-semibold underline">
                {o.reference} ({o.firstName} {o.lastName})
              </Link>
            </span>
          ))}
          {sameApplications.length > 0 && samePupils.length > 0 ? ", " : ""}
          {samePupils.map((p, i) => (
            <span key={p.id}>
              {i > 0 ? ", " : ""}
              <Link href={`/students/${p.id}`} className="font-semibold underline">
                {p.admissionNo} ({p.name})
              </Link>
            </span>
          ))}
          . Check before offering a place.
        </Alert>
      ) : null}

      {a.student ? (
        <Card title="Admitted">
          <p className="px-4.5 py-4 text-sm text-slate-700">
            Now a pupil:{" "}
            <Link href={`/students/${a.student.id}`} className="font-semibold text-brand-ink hover:underline">
              {a.student.firstName} {a.student.lastName} ({a.student.admissionNo})
            </Link>
          </p>
        </Card>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2">
        <Card title="The child">
          <dl className="grid grid-cols-2 gap-4 px-4.5 py-4">
            <Item label="Gender">{a.gender === "FEMALE" ? "Girl" : "Boy"}</Item>
            <Item label="Date of birth">{day(a.dateOfBirth)}</Item>
            <Item label="Other names">{a.middleName}</Item>
            <Item label="Previous school">{a.previousSchool}</Item>
            <div className="col-span-2">
              <Item label="Health or other notes">{a.notes}</Item>
            </div>
          </dl>
        </Card>
        <Card title="The parent or guardian">
          <dl className="grid grid-cols-2 gap-4 px-4.5 py-4">
            <Item label="Name">{a.guardianName}</Item>
            <Item label="Relationship">{relationship}</Item>
            <Item label="Phone">{a.guardianPhone}</Item>
            <Item label="Email">{a.guardianEmail}</Item>
          </dl>
        </Card>
      </div>

      <Card title="Entrance test or interview">
        <TestForm
          id={a.id}
          testedOn={iso(a.testedOn)}
          testScore={a.testScore === null ? "" : String(Number(a.testScore))}
          testNotes={a.testNotes ?? ""}
          locked={settled}
        />
      </Card>

      <Card title="Places">
        <p className="px-4.5 py-4 text-sm text-slate-700">
          {seats.limited ? (
            <>
              {a.level.name}, {a.academicYear.name}: <strong>{seats.left}</strong> of {seats.capacity} places left ({seats.enrolled} enrolled,{" "}
              {seats.held} offered or accepted).
            </>
          ) : (
            <>
              {a.level.name}, {a.academicYear.name}: no limit is set on its classes, so an offer is never refused for lack of room ({seats.enrolled} enrolled,{" "}
              {seats.held} offered or accepted).
            </>
          )}
        </p>
      </Card>

      {a.status === "ACCEPTED" ? (
        <Card title="Admit this child">
          <AdmitForm
            id={a.id}
            needsClass={yearIsCurrent}
            classes={classes.map((c) => ({
              id: c.id,
              label: `${a.level.name} ${c.name}${c.capacity !== null ? ` (${c.enrolled} of ${c.capacity})` : ` (${c.enrolled})`}`,
              full: c.capacity !== null && c.enrolled >= c.capacity,
            }))}
          />
        </Card>
      ) : null}

      {!settled ? (
        <Card title={`Where it stands: ${STATUS_LABEL[a.status].toLowerCase()}`}>
          <div className="grid gap-5 px-4.5 py-4 sm:grid-cols-2">
            {moves.map((to) => (
              <MoveForm
                key={to}
                id={a.id}
                to={to}
                label={moveLabel(a.status, to)}
                variant={to === "OFFERED" || to === "ACCEPTED" ? "primary" : "secondary"}
                withExpiry={to === "OFFERED"}
                withNote={to === "REJECTED" || to === "WITHDRAWN" || to === "WAITLISTED"}
              />
            ))}
          </div>
        </Card>
      ) : null}

      {!settled ? (
        <div className="pt-2">
          <DeleteForm id={a.id} />
        </div>
      ) : null}
    </div>
  );
}

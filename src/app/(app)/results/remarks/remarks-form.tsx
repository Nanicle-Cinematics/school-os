"use client";

import { useActionState } from "react";
import { saveClassRemarks } from "@/lib/results-actions";
import { SubmitButton } from "../../submit-button";
import { Alert, inputClass } from "../../ui";

type Student = { id: string; firstName: string; lastName: string; admissionNo: string };
type Row = {
  conduct: string | null;
  attitude: string | null;
  interest: string | null;
  formTeacherRemark: string | null;
  daysPresent: number | null;
  daysTotal: number | null;
  status: string;
};

/**
 * Common entries, offered as a datalist rather than a fixed dropdown.
 *
 * A closed list would be wrong — a teacher's observation of one child is not
 * drawn from six options — but typing "Punctual and respectful" forty times is
 * how these fields end up blank. Suggestions speed the common case and the
 * field stays free text.
 */
const CONDUCT = [
  "Well behaved and respectful",
  "Polite and cooperative",
  "Generally well behaved",
  "Needs to observe school rules",
  "Talks excessively in class",
];
const ATTITUDE = [
  "Hardworking and attentive",
  "Shows great enthusiasm",
  "Willing but easily distracted",
  "Needs constant supervision",
  "Reluctant to participate",
];
const INTEREST = [
  "Reading and storytelling",
  "Mathematics and puzzles",
  "Science and nature",
  "Football and athletics",
  "Music and dance",
  "Drawing and craft",
  "Drama and public speaking",
];
const REMARK = [
  "An excellent result. Keep it up.",
  "A very good performance this term.",
  "Good work, but can do better.",
  "Fair. More effort is needed next term.",
  "Must work harder, especially in the core subjects.",
];

function Suggestions({ id, items }: { id: string; items: string[] }) {
  return (
    <datalist id={id}>
      {items.map((item) => (
        <option key={item} value={item} />
      ))}
    </datalist>
  );
}

export function RemarksForm({
  termId,
  classGroupId,
  students,
  rows,
  daysInTerm,
  fromRegister,
}: {
  termId: string;
  classGroupId: string;
  students: Student[];
  rows: Record<string, Row>;
  daysInTerm: number | null;
  /** The register is being taken for this class, so attendance is derived. */
  fromRegister: boolean;
}) {
  const [state, formAction] = useActionState(saveClassRemarks, {});

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="termId" value={termId} />
      <input type="hidden" name="classGroupId" value={classGroupId} />

      {fromRegister ? (
        <p className="rounded-control bg-info-tint px-3.5 py-2.5 text-sm text-info-ink">
          Attendance for this class comes from the daily register now, so those two boxes are
          read-only. Correct a day on the Attendance screen and these follow.
        </p>
      ) : null}

      <Suggestions id="conduct-options" items={CONDUCT} />
      <Suggestions id="attitude-options" items={ATTITUDE} />
      <Suggestions id="interest-options" items={INTEREST} />
      <Suggestions id="remark-options" items={REMARK} />

      <div className="space-y-3">
        {students.map((student) => {
          const row = rows[student.id];
          const published = row?.status === "PUBLISHED";
          return (
            <div
              key={student.id}
              className="rounded-card border border-hairline bg-surface p-4"
            >
              <input type="hidden" name={`row:${student.id}`} value="1" />

              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {student.lastName}, {student.firstName}
                  </p>
                  <p className="text-xs text-slate-400">{student.admissionNo}</p>
                </div>
                {published ? (
                  <span className="rounded-full bg-warning-tint px-2 py-0.5 text-xs font-medium text-warning-ink">
                    card already published
                  </span>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="text-sm">
                  <span className="mb-1 block text-xs font-medium text-slate-500">
                    Conduct
                  </span>
                  <input
                    type="text"
                    name={`conduct:${student.id}`}
                    list="conduct-options"
                    maxLength={300}
                    defaultValue={row?.conduct ?? ""}
                    className={inputClass}
                  />
                </label>

                <label className="text-sm">
                  <span className="mb-1 block text-xs font-medium text-slate-500">
                    Attitude
                  </span>
                  <input
                    type="text"
                    name={`attitude:${student.id}`}
                    list="attitude-options"
                    maxLength={300}
                    defaultValue={row?.attitude ?? ""}
                    className={inputClass}
                  />
                </label>

                <label className="text-sm">
                  <span className="mb-1 block text-xs font-medium text-slate-500">
                    Interest
                  </span>
                  <input
                    type="text"
                    name={`interest:${student.id}`}
                    list="interest-options"
                    maxLength={300}
                    defaultValue={row?.interest ?? ""}
                    className={inputClass}
                  />
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="text-sm">
                    <span className="mb-1 block text-xs font-medium text-slate-500">
                      Present
                    </span>
                    <input
                      type="number"
                      name={`daysPresent:${student.id}`}
                      min={0}
                      defaultValue={row?.daysPresent ?? ""}
                      readOnly={fromRegister}
                      title={fromRegister ? "Counted from the register" : undefined}
                      className={`${inputClass}${fromRegister ? " bg-slate-100 text-slate-500" : ""}`}
                    />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-xs font-medium text-slate-500">
                      Out of
                    </span>
                    <input
                      type="number"
                      name={`daysTotal:${student.id}`}
                      min={0}
                      defaultValue={row?.daysTotal ?? (fromRegister ? "" : (daysInTerm ?? ""))}
                      readOnly={fromRegister}
                      title={fromRegister ? "Days the register was taken" : undefined}
                      className={`${inputClass}${fromRegister ? " bg-slate-100 text-slate-500" : ""}`}
                    />
                  </label>
                </div>
              </div>

              <label className="mt-3 block text-sm">
                <span className="mb-1 block text-xs font-medium text-slate-500">
                  Form teacher&rsquo;s remark
                </span>
                <input
                  type="text"
                  name={`formTeacherRemark:${student.id}`}
                  list="remark-options"
                  maxLength={300}
                  defaultValue={row?.formTeacherRemark ?? ""}
                  className={inputClass}
                />
              </label>
            </div>
          );
        })}
      </div>

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…">Save the class</SubmitButton>
        <p className="text-xs text-slate-500">
          The head&rsquo;s remark is written per student on their results page — it is the one line
          that should not be filled in in bulk.
        </p>
      </div>
    </form>
  );
}

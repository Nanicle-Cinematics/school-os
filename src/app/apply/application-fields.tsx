import { TRAP_FIELD, LIMITS } from "@/lib/admissions-rules";

/**
 * The fields of an application, in one place for the two forms that take one: the public page a parent fills
 * in on a phone, and the office's own form for a walk-in. Uncontrolled inputs with `defaultValue`, so the
 * office form can hand back what was typed after a refusal.
 *
 * It lives outside `(app)` on purpose: the public page must not import the signed-in shell's components.
 * The classes are the app's field look, written out here.
 */

const control =
  "w-full rounded-control border border-hairline bg-slate-100 px-3.5 py-2.5 text-sm outline-none transition focus:border-brand-500/40 focus:bg-surface focus:ring-4 focus:ring-brand-500/12";

function Box({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-400">{hint}</span> : null}
    </label>
  );
}

export type Option = { id: string; name: string };

export const RELATIONSHIP_OPTIONS: [string, string][] = [
  ["MOTHER", "Mother"],
  ["FATHER", "Father"],
  ["GUARDIAN", "Guardian"],
  ["GRANDPARENT", "Grandparent"],
  ["UNCLE", "Uncle"],
  ["AUNT", "Aunt"],
  ["SIBLING", "Brother or sister"],
  ["OTHER", "Someone else"],
];

export function ApplicationFields({
  defaults,
  levels,
  years,
  trap = false,
}: {
  defaults: Record<string, string>;
  levels: Option[];
  years: (Option & { isCurrent?: boolean })[];
  /** The public form carries a field no person sees. A script fills it and is told it worked. */
  trap?: boolean;
}) {
  const value = (key: string) => defaults[key] ?? "";
  const startYear = value("academicYearId") || years.find((y) => y.isCurrent)?.id || years[0]?.id || "";

  return (
    <div className="space-y-6">
      <fieldset className="space-y-4">
        <legend className="mb-1 text-sm font-semibold text-slate-900">The child</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Box label="First name">
            <input name="firstName" required maxLength={LIMITS.name} autoComplete="off" defaultValue={value("firstName")} className={control} />
          </Box>
          <Box label="Last name">
            <input name="lastName" required maxLength={LIMITS.name} autoComplete="off" defaultValue={value("lastName")} className={control} />
          </Box>
          <Box label="Other names" hint="Optional">
            <input name="middleName" maxLength={LIMITS.name} autoComplete="off" defaultValue={value("middleName")} className={control} />
          </Box>
          <Box label="Gender">
            <select name="gender" required defaultValue={value("gender")} className={control}>
              <option value="" disabled>
                Choose
              </option>
              <option value="FEMALE">Girl</option>
              <option value="MALE">Boy</option>
            </select>
          </Box>
          <Box label="Date of birth">
            <input type="date" name="dateOfBirth" defaultValue={value("dateOfBirth")} className={control} />
          </Box>
          <Box label="Previous school" hint="Optional">
            <input name="previousSchool" maxLength={LIMITS.place} autoComplete="off" defaultValue={value("previousSchool")} className={control} />
          </Box>
        </div>
        <Box label="Health, or anything else the school should know" hint="Allergies, a condition, a learning need. Optional.">
          <textarea name="notes" rows={3} maxLength={LIMITS.notes} defaultValue={value("notes")} className={control} />
        </Box>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-1 text-sm font-semibold text-slate-900">The parent or guardian</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Box label="Full name">
            <input name="guardianName" required maxLength={LIMITS.name * 2} autoComplete="name" defaultValue={value("guardianName")} className={control} />
          </Box>
          <Box label="Relationship to the child">
            <select name="guardianRelationship" defaultValue={value("guardianRelationship") || "MOTHER"} className={control}>
              {RELATIONSHIP_OPTIONS.map(([id, text]) => (
                <option key={id} value={id}>
                  {text}
                </option>
              ))}
            </select>
          </Box>
          <Box label="Phone number" hint="We text this number about the application. e.g. 0244123456">
            <input type="tel" name="guardianPhone" required inputMode="tel" maxLength={20} autoComplete="tel" defaultValue={value("guardianPhone")} className={control} />
          </Box>
          <Box label="Email" hint="Optional">
            <input type="email" name="guardianEmail" maxLength={LIMITS.email} autoComplete="email" defaultValue={value("guardianEmail")} className={control} />
          </Box>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-1 text-sm font-semibold text-slate-900">The place</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Box label="Class applying for">
            <select name="levelId" required defaultValue={value("levelId")} className={control}>
              <option value="" disabled>
                Choose
              </option>
              {levels.map((level) => (
                <option key={level.id} value={level.id}>
                  {level.name}
                </option>
              ))}
            </select>
          </Box>
          <Box label="Starting in">
            <select name="academicYearId" required defaultValue={startYear} className={control}>
              {years.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.name}
                </option>
              ))}
            </select>
          </Box>
        </div>
      </fieldset>

      {trap ? (
        <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label>
            Leave this empty
            <input name={TRAP_FIELD} tabIndex={-1} autoComplete="off" defaultValue="" />
          </label>
        </div>
      ) : null}
    </div>
  );
}

/** The values of a form as the plain object both forms send. */
export function formValues(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]));
}

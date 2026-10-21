import type { ReactNode } from "react";

/**
 * The building blocks of the blank enrolment forms (pupils and staff).
 *
 * These are paper forms for a person to fill in by hand and the office to key into the admit / add screens, so they ask
 * for what those screens store and nothing else. Every field name here is one of theirs.
 */

/** A labelled blank line to write on. */
export function Line({ label, className = "" }: { label: string; className?: string }) {
  return (
    <div className={`flex items-end gap-2 ${className}`}>
      <span className="shrink-0 text-xs text-slate-600">{label}</span>
      <span className="h-6 min-w-0 flex-1 border-b border-slate-400" />
    </div>
  );
}

/** A row of tick boxes, for the fields that have a short fixed set of answers. */
export function Choice({ label, options, className = "" }: { label: string; options: string[]; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${className}`}>
      <span className="text-xs text-slate-600">{label}</span>
      {options.map((option) => (
        <span key={option} className="flex items-center gap-1.5 text-xs text-slate-800">
          <span className="inline-block h-3.5 w-3.5 border border-slate-500" />
          {option}
        </span>
      ))}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 break-inside-avoid pt-4">
      <h2 className="border-b border-slate-300 pb-1 text-xs font-semibold tracking-wide text-brand-800">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-6 gap-y-3">{children}</div>;
}

/** Signature and date, then the strip the office fills in. */
export function Signatures({ signer, office }: { signer: string; office: string[] }) {
  return (
    <>
      <Section title="Declaration">
        <p className="text-xs text-slate-700">I confirm that the information on this form is true and complete to the best of my knowledge.</p>
        <Grid>
          <Line label={signer} />
          <Line label="Date" />
        </Grid>
      </Section>
      <div className="mt-5 break-inside-avoid rounded border border-dashed border-slate-400 p-3">
        <p className="mb-2 text-xs font-semibold tracking-wide text-slate-500">For office use</p>
        <Grid>
          {office.map((label) => (
            <Line key={label} label={label} />
          ))}
        </Grid>
      </div>
    </>
  );
}

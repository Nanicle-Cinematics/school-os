"use client";

import { useActionState, useRef, useState, type FormEvent } from "react";
import { recordPayment, type PaymentState } from "@/lib/payment-actions";
import { MAX_ATTACHMENT_BYTES } from "@/lib/attachment-constants";
import { SubmitButton } from "../submit-button";
import { Alert, Field, inputClass } from "../ui";

export type StudentOption = {
  id: string;
  label: string;
  admissionNo: string;
  className: string;
  balance: number;
};


/**
 * Which field a refusal is ABOUT.
 *
 * ⚠️ A presentational bridge, and deliberately not a change to the action.
 * `recordPayment` returns one `error` string, and rewriting it to return a
 * field key would be a change to a Server Action — out of scope for a visual
 * pass. So the form maps the messages it knows to the fields they concern, and
 * anything unmatched still falls through to the card-level alert exactly as
 * before. Nothing is lost if this map goes stale; the error simply shows where
 * it always did.
 *
 * The fix this stands in for: have the action return `{ field, message }`, and
 * delete this.
 */
const FIELD_FOR: { match: RegExp; field: "student" | "amount" | "reference" }[] = [
  { match: /student this payment is for|student no longer exists/i, field: "student" },
  { match: /amount/i, field: "amount" },
  { match: /transaction reference/i, field: "reference" },
];

function fieldError(error: string | undefined, field: string) {
  if (!error) return undefined;
  return FIELD_FOR.find((rule) => rule.match.test(error))?.field === field ? error : undefined;
}

/** True when the message belongs to a field, so the card does not repeat it. */
function isFieldError(error: string | undefined) {
  return Boolean(error && FIELD_FOR.some((rule) => rule.match.test(error)));
}

export function RecordForm({ students }: { students: StudentOption[] }) {
  const [state, formAction] = useActionState<PaymentState, FormData>(recordPayment, {});
  const [studentId, setStudentId] = useState("");
  const [method, setMethod] = useState("CASH");
  const [query, setQuery] = useState("");
  const slipRef = useRef<HTMLInputElement>(null);
  // Caught before the request goes out. Server Actions cap the request body
  // well above MAX_ATTACHMENT_BYTES (see next.config.ts), but a photo
  // straight off a phone clears even that routinely — without this, an
  // oversized slip fails at the platform level instead of with a reason.
  const [slipError, setSlipError] = useState<string | undefined>(undefined);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const file = slipRef.current?.files?.[0];
    if (file && file.size > MAX_ATTACHMENT_BYTES) {
      event.preventDefault();
      setSlipError(
        `That file is ${Math.round(file.size / 1024 / 1024)} MB. Keep it under ${
          MAX_ATTACHMENT_BYTES / 1024 / 1024
        } MB.`,
      );
    }
  }

  const filtered = query.trim()
    ? students.filter((s) =>
        `${s.label} ${s.admissionNo} ${s.className}`.toLowerCase().includes(query.toLowerCase()),
      )
    : students;

  const selected = students.find((s) => s.id === studentId);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form
      action={formAction}
      onSubmit={handleSubmit}
      encType="multipart/form-data"
      className="rounded-card border border-hairline bg-surface p-4 lg:p-5"
    >
      <h2 className="text-sm font-semibold text-slate-900">Record a payment</h2>
      <p className="mt-0.5 text-sm text-slate-500">
        The amount clears the oldest unpaid invoice first, so arrears settle before this term.
      </p>

      <input type="hidden" name="studentId" value={studentId} />

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <Field label="Find student" hint="Search by name or admission number.">
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. Mensah or HEC/0012"
            className={inputClass}
          />
        </Field>

        <Field label="Student" error={fieldError(state.error, "student")}>
          <select
            value={studentId}
            onChange={(event) => setStudentId(event.target.value)}
            className={inputClass}
            required
          >
            <option value="">Choose a student…</option>
            {filtered.slice(0, 60).map((student) => (
              <option key={student.id} value={student.id}>
                {student.label} · {student.admissionNo}
                {student.balance > 0 ? ` · owes GHS ${student.balance.toFixed(2)}` : " · settled"}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {selected ? (
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <span className="font-medium text-slate-900">{selected.label}</span>
          <span className="text-slate-500"> · {selected.className}</span>
          {selected.balance > 0 ? (
            <span className="ml-2 font-medium text-danger-ink">
              Outstanding GHS {selected.balance.toFixed(2)}
            </span>
          ) : (
            <span className="ml-2 font-medium text-success-ink">No outstanding balance</span>
          )}
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Amount (GHS)" error={fieldError(state.error, "amount")}>
          <input
            type="text"
            inputMode="decimal"
            name="amount"
            placeholder="0.00"
            required
            className={inputClass}
          />
        </Field>

        <Field label="Method">
          <select
            name="method"
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            className={inputClass}
          >
            <option value="CASH">Cash</option>
            <option value="MOBILE_MONEY">Mobile money</option>
            <option value="BANK_DEPOSIT">Bank deposit</option>
            <option value="BANK_TRANSFER">Bank transfer</option>
            <option value="CHEQUE">Cheque</option>
          </select>
        </Field>

        {method === "MOBILE_MONEY" ? (
          <Field label="Network">
            <select name="momoNetwork" className={inputClass} defaultValue="MTN">
              <option value="MTN">MTN</option>
              <option value="TELECEL">Telecel</option>
              <option value="AIRTELTIGO">AirtelTigo</option>
            </select>
          </Field>
        ) : (
          <Field label="Date received">
            <input type="date" name="paidAt" defaultValue={today} className={inputClass} />
          </Field>
        )}

        <Field
          label="Reference"
          hint={method === "MOBILE_MONEY" ? "Required for mobile money." : "Slip or cheque number."}
          error={fieldError(state.error, "reference")}
        >
          <input type="text" name="reference" className={inputClass} />
        </Field>
      </div>

      {method === "MOBILE_MONEY" ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Date received">
            <input type="date" name="paidAt" defaultValue={today} className={inputClass} />
          </Field>
        </div>
      ) : null}

      <div className="mt-3">
        <Field label="Note (optional)">
          <input type="text" name="note" className={inputClass} />
        </Field>

        {/* The bank slip or momo screenshot. Optional — cash across the counter
            has no slip — but it is what makes a payment reconcilable later. */}
        <Field label="Bank slip" hint="Photo or PDF. Optional." error={slipError}>
          <input
            ref={slipRef}
            type="file"
            name="slip"
            accept="image/png,image/jpeg,image/webp,image/heic,application/pdf"
            onChange={() => setSlipError(undefined)}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-full file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
          />
        </Field>
      </div>

      {/* Only what no field claimed. A message shown beside the control AND
          repeated in a banner reads as two problems. */}
      {state.error && !isFieldError(state.error) ? (
        <div className="mt-4">
          <Alert tone="error">{state.error}</Alert>
        </div>
      ) : null}

      <div className="mt-5">
        <SubmitButton pendingLabel="Recording…">Record payment &amp; issue receipt</SubmitButton>
      </div>
    </form>
  );
}

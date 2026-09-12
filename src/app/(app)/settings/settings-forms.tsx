"use client";

import { useActionState } from "react";
import {
  saveAcademicPolicy,
  saveFeesPolicy,
  saveSchoolProfile,
  saveSmsSettings,
  sendTestSms,
  type SettingsState,
  type TestSmsState,
} from "@/lib/settings-actions";
import { SubmitButton } from "../submit-button";
import { Alert, Field, filterClass, inputClass } from "../ui";

function Feedback({ state }: { state: SettingsState | TestSmsState }) {
  if (!state.error && !state.ok) {
    return null;
  }
  return (
    <div className="mt-4">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.ok ? <Alert tone="success">{state.ok}</Alert> : null}
    </div>
  );
}

export type SchoolValues = {
  name: string;
  shortName: string | null;
  motto: string | null;
  headName: string | null;
  email: string | null;
  phone: string | null;
  altPhone: string | null;
  website: string | null;
  address: string | null;
  town: string | null;
  district: string | null;
  region: string | null;
  gpsAddress: string | null;
  accreditationNo: string | null;
};

export function ProfileForm({ values }: { values: SchoolValues }) {
  const [state, formAction] = useActionState<SettingsState, FormData>(saveSchoolProfile, {});

  return (
    <form action={formAction} className="p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="School name">
          <input
            type="text"
            name="name"
            required
            defaultValue={values.name}
            className={inputClass}
          />
        </Field>

        <Field label="Short name" hint="Printed on report cards; also the SMS sender.">
          <input
            type="text"
            name="shortName"
            maxLength={11}
            defaultValue={values.shortName ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Motto">
          <input type="text" name="motto" defaultValue={values.motto ?? ""} className={inputClass} />
        </Field>

        <Field label="Headteacher">
          <input
            type="text"
            name="headName"
            defaultValue={values.headName ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Phone">
          <input type="tel" name="phone" defaultValue={values.phone ?? ""} className={inputClass} />
        </Field>

        <Field label="Alternate phone">
          <input
            type="tel"
            name="altPhone"
            defaultValue={values.altPhone ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Email">
          <input type="email" name="email" defaultValue={values.email ?? ""} className={inputClass} />
        </Field>

        <Field label="Website">
          <input
            type="text"
            name="website"
            defaultValue={values.website ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="GES / Ministry number">
          <input
            type="text"
            name="accreditationNo"
            defaultValue={values.accreditationNo ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Address">
          <input
            type="text"
            name="address"
            defaultValue={values.address ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Town">
          <input type="text" name="town" defaultValue={values.town ?? ""} className={inputClass} />
        </Field>

        <Field label="District">
          <input
            type="text"
            name="district"
            defaultValue={values.district ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="Region">
          <input
            type="text"
            name="region"
            defaultValue={values.region ?? ""}
            className={inputClass}
          />
        </Field>

        <Field label="GhanaPost GPS">
          <input
            type="text"
            name="gpsAddress"
            placeholder="GA-123-4567"
            defaultValue={values.gpsAddress ?? ""}
            className={inputClass}
          />
        </Field>
      </div>

      <Feedback state={state} />

      <div className="mt-4">
        <SubmitButton pendingLabel="Saving…">Save profile</SubmitButton>
      </div>
    </form>
  );
}

export type AcademicValues = {
  classScoreWeight: number;
  examScoreWeight: number;
  aggregateSubjects: number;
  defaultGradingScaleId: string | null;
  showClassPosition: boolean;
  showSubjectPosition: boolean;
  showAggregate: boolean;
};

export function AcademicForm({
  values,
  scales,
}: {
  values: AcademicValues;
  scales: { id: string; name: string }[];
}) {
  const [state, formAction] = useActionState<SettingsState, FormData>(saveAcademicPolicy, {});

  return (
    <form action={formAction} className="p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Class score weight (%)" hint="30 for SHS, 50 for basic.">
          <input
            type="number"
            name="classScoreWeight"
            min={0}
            max={100}
            required
            defaultValue={values.classScoreWeight}
            className={inputClass}
          />
        </Field>

        <Field label="Exam weight (%)" hint="Must make 100 with the class score.">
          <input
            type="number"
            name="examScoreWeight"
            min={0}
            max={100}
            required
            defaultValue={values.examScoreWeight}
            className={inputClass}
          />
        </Field>

        <Field label="Default grading scale">
          <select
            name="defaultGradingScaleId"
            defaultValue={values.defaultGradingScaleId ?? ""}
            className={inputClass}
          >
            <option value="">None</option>
            {scales.map((scale) => (
              <option key={scale.id} value={scale.id}>
                {scale.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Subjects in aggregate" hint="BECE best-6.">
          <input
            type="number"
            name="aggregateSubjects"
            min={1}
            max={12}
            required
            defaultValue={values.aggregateSubjects}
            className={inputClass}
          />
        </Field>

        {/* No "Report card template" picker. It offered GES standard and
            "Compact", saved the answer, and there has only ever been one
            layout — so choosing Compact changed nothing and said nothing.
            A control with one real option is not a choice. */}
      </div>

      <div className="mt-4 flex flex-wrap gap-4 text-sm text-slate-700">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="showClassPosition"
            defaultChecked={values.showClassPosition}
            className="h-4 w-4"
          />
          Show position in class
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="showSubjectPosition"
            defaultChecked={values.showSubjectPosition}
            className="h-4 w-4"
          />
          Show position per subject
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="showAggregate"
            defaultChecked={values.showAggregate}
            className="h-4 w-4"
          />
          Show aggregate
        </label>
      </div>

      <Feedback state={state} />

      <div className="mt-4">
        <SubmitButton pendingLabel="Saving…">Save academic policy</SubmitButton>
      </div>
    </form>
  );
}

export function FeesForm({
  values,
}: {
  values: {
    invoiceDueDays: number;
    blockReportOnArrears: boolean;
    paymentInstructions: string;
    invoiceNote: string;
  };
}) {
  const [state, formAction] = useActionState<SettingsState, FormData>(saveFeesPolicy, {});

  return (
    <form action={formAction} className="p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Days until an invoice is due">
          <input
            type="number"
            name="invoiceDueDays"
            min={0}
            required
            defaultValue={values.invoiceDueDays}
            className={inputClass}
          />
        </Field>

        <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="blockReportOnArrears"
            defaultChecked={values.blockReportOnArrears}
            className="h-4 w-4"
          />
          Withhold report cards from students in arrears
        </label>
      </div>

      <div className="mt-3 grid gap-3">
        <Field
          label="How to pay"
          hint="Printed on every invoice. Momo number and merchant name, bank account, or where to pay at the school."
        >
          <textarea
            name="paymentInstructions"
            rows={4}
            defaultValue={values.paymentInstructions}
            placeholder={"MTN MoMo: 024 000 0000 (Nanicle Academy)\nBank: GCB 1234567890123, Adum Branch\nOr pay at the bursar's office, 8am–3pm."}
            className={inputClass}
          />
        </Field>

        <Field label="Note under the total" hint="One line, e.g. a deadline or a late-payment rule.">
          <input
            type="text"
            name="invoiceNote"
            maxLength={200}
            defaultValue={values.invoiceNote}
            placeholder="Fees are payable in full by the third week of term."
            className={inputClass}
          />
        </Field>
      </div>

      <Feedback state={state} />

      <div className="mt-4">
        <SubmitButton pendingLabel="Saving…">Save fees policy</SubmitButton>
      </div>
    </form>
  );
}

export function SmsForm({
  values,
}: {
  values: {
    smsEnabled: boolean;
    smsProvider: string | null;
    smsSenderId: string | null;
    notifyOnPayment: boolean;
    notifyOnResultPublish: boolean;
  };
}) {
  const [state, formAction] = useActionState<SettingsState, FormData>(saveSmsSettings, {});

  return (
    <form action={formAction} className="p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Provider">
          <select
            name="smsProvider"
            defaultValue={values.smsProvider ?? ""}
            className={inputClass}
          >
            <option value="">Not set</option>
            <option value="ARKESEL">Arkesel</option>
            <option value="HUBTEL">Hubtel</option>
            <option value="MNOTIFY">mNotify</option>
          </select>
        </Field>

        <Field label="Sender ID" hint="Max 11 characters, as registered with the provider.">
          <input
            type="text"
            name="smsSenderId"
            maxLength={11}
            defaultValue={values.smsSenderId ?? ""}
            className={inputClass}
          />
        </Field>

        <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="smsEnabled"
            defaultChecked={values.smsEnabled}
            className="h-4 w-4"
          />
          Sending is on
        </label>
      </div>

      <div className="mt-4 flex flex-wrap gap-4 text-sm text-slate-700">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="notifyOnPayment"
            defaultChecked={values.notifyOnPayment}
            className="h-4 w-4"
          />
          Text a receipt when a payment is recorded
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="notifyOnResultPublish"
            defaultChecked={values.notifyOnResultPublish}
            className="h-4 w-4"
          />
          Text guardians when results are published
        </label>
      </div>

      <Feedback state={state} />

      <div className="mt-4">
        <SubmitButton pendingLabel="Saving…">Save SMS settings</SubmitButton>
      </div>

      <TestSms />
    </form>
  );
}

/**
 * Prove the gateway with one number before a school's parents are the test.
 *
 * Sits inside the SMS card because that is where someone has just typed a
 * provider and a sender ID and has no way to know whether either is right — a
 * wrong key and an unregistered sender ID both look like silence from here.
 */
function TestSms() {
  const [state, action] = useActionState<TestSmsState, FormData>(sendTestSms, {});

  return (
    <div className="mt-5 border-t border-slate-100 pt-4">
      <p className="text-sm font-semibold text-slate-900">Send a test</p>
      <p className="mt-0.5 text-sm text-slate-500">
        One message, to a number you can check, using the settings above. It sends whether or not
        SMS is switched on, so you can test the wiring before any parent hears from the school.
      </p>

      <Feedback state={state} />

      <div className="mt-3 flex flex-wrap items-start gap-2">
        <input
          type="tel"
          name="testPhone"
          placeholder="0244000000"
          aria-label="Number to test with"
          className={`${filterClass} w-44`}
        />
        <SubmitButton formAction={action} variant="secondary" pendingLabel="Sending…">
          Send a test message
        </SubmitButton>
      </div>
    </div>
  );
}

"use client";

import { useActionState } from "react";
import {
  addPayItemAction,
  approveRunAction,
  confirmRateSetAction,
  createRunAction,
  deleteRateSetAction,
  deleteRunAction,
  markPaidAction,
  recalculateRunAction,
  reopenRunAction,
  saveAccountsAction,
  saveRateSetAction,
  saveStaffPayAction,
  setPayItemAction,
  setUpPayrollAction,
  type PayrollState,
} from "@/lib/payroll-actions";
import { buttonClass } from "../button-style";
import { SubmitButton } from "../submit-button";
import { Alert, inputClass } from "../ui";

const Message = ({ state }: { state: PayrollState }) =>
  state.error ? <Alert tone="error">{state.error}</Alert> : state.ok ? <Alert tone="success">{state.ok}</Alert> : null;

const Label = ({ text, children, hint }: { text: string; children: React.ReactNode; hint?: string }) => (
  <label className="block">
    <span className="mb-1.5 block text-sm font-medium text-slate-700">{text}</span>
    {children}
    {hint ? <span className="mt-1 block text-xs text-slate-400">{hint}</span> : null}
  </label>
);

/* ───────────────────────────── a run ───────────────────────────── */

export function StartRunForm({ defaultMonth, maxMonth }: { defaultMonth: string; maxMonth: string }) {
  const [state, action] = useActionState<PayrollState, FormData>(createRunAction, {});
  return (
    <form action={action} className="space-y-3 px-4.5 py-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="Month to pay">
          <input type="month" name="period" required max={maxMonth} defaultValue={state.values?.period ?? defaultMonth} className={inputClass} />
        </Label>
        <Label text="Note (optional)" hint="Shown on the run, not on payslips.">
          <input name="note" maxLength={200} defaultValue={state.values?.note ?? ""} className={inputClass} />
        </Label>
      </div>
      <Message state={state} />
      <SubmitButton pendingLabel="Working it out…">Work out this month</SubmitButton>
    </form>
  );
}

function RunStep({
  runId,
  action,
  label,
  pending,
  variant = "secondary",
  confirm,
}: {
  runId: string;
  action: (prev: PayrollState, formData: FormData) => Promise<PayrollState>;
  label: string;
  pending: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  confirm?: string;
}) {
  const [state, dispatch] = useActionState<PayrollState, FormData>(action, {});
  return (
    <form
      action={dispatch}
      onSubmit={confirm ? (e) => { if (!window.confirm(confirm)) e.preventDefault(); } : undefined}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="runId" value={runId} />
      <SubmitButton variant={variant} pendingLabel={pending}>{label}</SubmitButton>
      <Message state={state} />
    </form>
  );
}

export const RecalculateButton = ({ runId }: { runId: string }) => (
  <RunStep runId={runId} action={recalculateRunAction} label="Work it out again" pending="Working…" />
);
export const ApproveButton = ({ runId }: { runId: string }) => (
  <RunStep runId={runId} action={approveRunAction} label="Approve this run" pending="Approving…" variant="primary" confirm="Approve this run? It will be posted to the accounts and its figures locked." />
);
export const ReopenButton = ({ runId }: { runId: string }) => (
  <RunStep runId={runId} action={reopenRunAction} label="Reopen as a draft" pending="Reopening…" variant="ghost" confirm="Reopen this run? What it posted to the accounts will be reversed." />
);
export const DeleteRunButton = ({ runId }: { runId: string }) => (
  <RunStep runId={runId} action={deleteRunAction} label="Delete this draft" pending="Deleting…" variant="danger" confirm="Delete this draft run?" />
);

export function MarkPaidForm({ runId, today }: { runId: string; today: string }) {
  const [state, action] = useActionState<PayrollState, FormData>(markPaidAction, {});
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="runId" value={runId} />
      <Label text="Date paid">
        <input type="date" name="paidOn" required max={today} defaultValue={state.values?.paidOn ?? today} className={inputClass} />
      </Label>
      <Label text="How it was paid">
        <select name="method" defaultValue={state.values?.method ?? "BANK_TRANSFER"} className={inputClass}>
          <option value="BANK_TRANSFER">Bank transfer</option>
          <option value="MOBILE_MONEY">Mobile money</option>
          <option value="CASH">Cash</option>
        </select>
      </Label>
      <Message state={state} />
      <SubmitButton pendingLabel="Saving…">Mark as paid</SubmitButton>
    </form>
  );
}

/* ───────────────────────────── one person ───────────────────────────── */

export function StaffPayForm({ staffId, basic, ssnitApplies }: { staffId: string; basic: string; ssnitApplies: boolean }) {
  const [state, action] = useActionState<PayrollState, FormData>(saveStaffPayAction, {});
  const v = (key: string, saved: string) => state.values?.[key] ?? saved;
  return (
    <form action={action} className="space-y-3 px-4.5 py-4">
      <input type="hidden" name="staffId" value={staffId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="Basic salary each month (GH¢)">
          <input name="basic" inputMode="decimal" required defaultValue={v("basic", basic)} className={inputClass} />
        </Label>
        <Label text="Contributes to SSNIT" hint="Off for someone who is not enrolled or is past retirement age.">
          <select name="ssnitApplies" defaultValue={v("ssnitApplies", ssnitApplies ? "yes" : "no")} className={inputClass}>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Label>
      </div>
      <Message state={state} />
      <SubmitButton variant="primary" pendingLabel="Saving…">Save pay</SubmitButton>
    </form>
  );
}

export function AddItemForm({ staffId }: { staffId: string }) {
  const [state, action] = useActionState<PayrollState, FormData>(addPayItemAction, {});
  const v = (key: string, saved = "") => state.values?.[key] ?? saved;
  return (
    <form action={action} className="space-y-3 px-4.5 py-4">
      <input type="hidden" name="staffId" value={staffId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="What is it">
          <select name="kind" defaultValue={v("kind", "ALLOWANCE")} className={inputClass}>
            <option value="ALLOWANCE">Allowance (added to pay)</option>
            <option value="DEDUCTION">Deduction (taken from pay)</option>
          </select>
        </Label>
        <Label text="Name" hint="For example Transport, or Salary advance.">
          <input name="name" required maxLength={60} defaultValue={v("name")} className={inputClass} />
        </Label>
        <Label text="Amount each month (GH¢)">
          <input name="amount" inputMode="decimal" required defaultValue={v("amount")} className={inputClass} />
        </Label>
        <Label text="Allowance is taxable" hint="Most allowances are. Allowances only.">
          <select name="taxable" defaultValue={v("taxable", "yes")} className={inputClass}>
            <option value="yes">Yes, taxed</option>
            <option value="no">No</option>
          </select>
        </Label>
        <Label text="Total owed (GH¢), for a loan" hint="Deductions only. It stops when this much has been taken. Leave blank to go on until stopped.">
          <input name="principal" inputMode="decimal" defaultValue={v("principal")} className={inputClass} />
        </Label>
      </div>
      <Message state={state} />
      <SubmitButton variant="secondary" pendingLabel="Adding…">Add</SubmitButton>
    </form>
  );
}

export function ItemControls({ staffId, itemId, active }: { staffId: string; itemId: string; active: boolean }) {
  const [state, action] = useActionState<PayrollState, FormData>(setPayItemAction, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="staffId" value={staffId} />
      <input type="hidden" name="itemId" value={itemId} />
      <button name="change" value={active ? "stop" : "resume"} className={buttonClass("ghost", "sm")}>
        {active ? "Stop" : "Resume"}
      </button>
      <button
        name="change"
        value="remove"
        className={buttonClass("danger", "sm")}
        onClick={(e) => { if (!window.confirm("Remove this item?")) e.preventDefault(); }}
      >
        Remove
      </button>
      {state.error ? <span className="text-xs text-danger-ink">{state.error}</span> : null}
    </form>
  );
}

/* ───────────────────────────── set-up ───────────────────────────── */

export function SetUpButton() {
  const [state, action] = useActionState<PayrollState, FormData>(setUpPayrollAction, {});
  return (
    <form action={action} className="space-y-2">
      <SubmitButton variant="secondary" pendingLabel="Setting up…">Set up payroll</SubmitButton>
      <Message state={state} />
    </form>
  );
}

const ACCOUNT_FIELDS = [
  { key: "payrollSalaryAccountId", mapKey: "salary", label: "Salaries expense", hint: "Where the gross pay and the employer's SSNIT are charged." },
  { key: "payrollPayeAccountId", mapKey: "paye", label: "PAYE payable", hint: "What is owed to GRA." },
  { key: "payrollSsnitAccountId", mapKey: "ssnit", label: "SSNIT payable", hint: "Both shares, owed to SSNIT and the Tier 2 trustee." },
  { key: "payrollNetPayAccountId", mapKey: "netPay", label: "Net salaries payable", hint: "What is owed to staff until it is paid." },
  { key: "payrollAdvancesAccountId", mapKey: "advances", label: "Staff advances and loans", hint: "Deductions recovered from staff pay." },
] as const;

export function AccountsForm({
  accounts,
  mapping,
}: {
  accounts: { id: string; code: string; name: string; type: string }[];
  mapping: Record<"salary" | "paye" | "ssnit" | "netPay" | "advances", string>;
}) {
  const [state, action] = useActionState<PayrollState, FormData>(saveAccountsAction, {});
  return (
    <form action={action} className="space-y-3 px-4.5 py-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {ACCOUNT_FIELDS.map((f) => (
          <Label key={f.key} text={f.label} hint={f.hint}>
            <select name={f.key} defaultValue={state.values?.[f.key] ?? mapping[f.mapKey]} className={inputClass}>
              <option value="">Not posted</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
              ))}
            </select>
          </Label>
        ))}
      </div>
      <Message state={state} />
      <SubmitButton variant="secondary" pendingLabel="Saving…">Save accounts</SubmitButton>
    </form>
  );
}

export type RateSetFormValues = {
  id: string;
  label: string;
  effectiveFrom: string;
  employee: string;
  employer: string;
  tier2: string;
  maxInsurable: string;
  bandsText: string;
};

export function RateSetForm({ initial, frozen }: { initial: RateSetFormValues; frozen: boolean }) {
  const [state, action] = useActionState<PayrollState, FormData>(saveRateSetAction, {});
  const v = (key: string, saved: string) => state.values?.[key] ?? saved;
  return (
    <form action={action} className="space-y-3 px-4.5 py-4">
      <input type="hidden" name="id" value={initial.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Label text="Label">
          <input name="label" required maxLength={60} disabled={frozen} defaultValue={v("label", initial.label)} className={inputClass} />
        </Label>
        <Label text="Starts on">
          <input type="date" name="effectiveFrom" required disabled={frozen} defaultValue={v("effectiveFrom", initial.effectiveFrom)} className={inputClass} />
        </Label>
        <Label text="Employee SSNIT (%)">
          <input name="ssnitEmployeePercent" inputMode="decimal" required disabled={frozen} defaultValue={v("ssnitEmployeePercent", initial.employee)} className={inputClass} />
        </Label>
        <Label text="Employer SSNIT (%)">
          <input name="ssnitEmployerPercent" inputMode="decimal" required disabled={frozen} defaultValue={v("ssnitEmployerPercent", initial.employer)} className={inputClass} />
        </Label>
        <Label text="Tier 2 share of the total (%)" hint="Only divides the remittance between SSNIT and the trustee.">
          <input name="ssnitTier2Percent" inputMode="decimal" required disabled={frozen} defaultValue={v("ssnitTier2Percent", initial.tier2)} className={inputClass} />
        </Label>
        <Label text="SSNIT ceiling, basic salary a month (GH¢)">
          <input name="ssnitMaxInsurable" inputMode="decimal" required disabled={frozen} defaultValue={v("ssnitMaxInsurable", initial.maxInsurable)} className={inputClass} />
        </Label>
      </div>
      <Label text="Monthly PAYE bands" hint={'One band a line as "amount, rate", lowest first. The last line is "rest, rate". For example: 588, 0'}>
        <textarea name="taxBands" rows={8} required disabled={frozen} defaultValue={v("taxBands", initial.bandsText)} className={`${inputClass} font-mono`} />
      </Label>
      <Message state={state} />
      {frozen ? (
        <p className="text-sm text-slate-500">A payroll run has used these rates, so they cannot be changed. Add new rates with a later start date.</p>
      ) : (
        <SubmitButton variant="secondary" pendingLabel="Saving…">{initial.id ? "Save these rates" : "Add these rates"}</SubmitButton>
      )}
    </form>
  );
}

function SimpleIdForm({
  id,
  action,
  label,
  pending,
  variant,
  confirm,
}: {
  id: string;
  action: (prev: PayrollState, formData: FormData) => Promise<PayrollState>;
  label: string;
  pending: string;
  variant: "primary" | "secondary" | "ghost" | "danger";
  confirm?: string;
}) {
  const [state, dispatch] = useActionState<PayrollState, FormData>(action, {});
  return (
    <form
      action={dispatch}
      onSubmit={confirm ? (e) => { if (!window.confirm(confirm)) e.preventDefault(); } : undefined}
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant={variant} pendingLabel={pending}>{label}</SubmitButton>
      <Message state={state} />
    </form>
  );
}

export const ConfirmRatesButton = ({ id }: { id: string }) => (
  <SimpleIdForm id={id} action={confirmRateSetAction} label="I have checked these rates" pending="Confirming…" variant="primary" confirm="Confirm that these rates match GRA's PAYE table and SSNIT's rates? A run can only be approved on confirmed rates." />
);
export const DeleteRatesButton = ({ id }: { id: string }) => (
  <SimpleIdForm id={id} action={deleteRateSetAction} label="Remove these rates" pending="Removing…" variant="danger" confirm="Remove these rates?" />
);

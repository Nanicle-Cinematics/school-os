import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { PAYROLL, PAYROLL_APPROVE, canAccess } from "@/lib/permissions";
import { getPayrollSetup } from "@/lib/payroll-data";
import { STARTING_RATES, bandsToText } from "@/lib/payroll-rules";
import { Card, PageHeader, StatusBadge } from "../../ui";
import { ButtonLink } from "../../primitives";
import { AccountsForm, ConfirmRatesButton, DeleteRatesButton, RateSetForm, SetUpButton } from "../forms";
import { day } from "../format";

export const metadata: Metadata = { title: "Payroll set-up · School OS" };
export const dynamic = "force-dynamic";

const dateInput = (value: Date) => new Date(value).toISOString().slice(0, 10);

export default async function PayrollSetupPage() {
  const auth = await requireRole(PAYROLL);
  const { sets, accounts, mapping } = await getPayrollSetup(auth.schoolId);
  const canRates = canAccess(auth.roles, PAYROLL_APPROVE);
  const latest = sets[0];

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Payroll set-up"
        subtitle="The statutory rates a month is worked out on, and the accounts a run posts to."
        action={<ButtonLink href="/payroll">Payroll</ButtonLink>}
      />

      <Card title="Start from the standard set-up">
        <div className="space-y-3 px-4.5 py-4">
          <p className="text-sm text-slate-600">
            Adds the five payroll accounts to the chart of accounts and chooses them below, and gives the school the starting rates from GRA and
            SSNIT. It only adds what is missing and never changes a choice already made.
          </p>
          <SetUpButton />
        </div>
      </Card>

      <h2 className="px-0.5 pt-2 font-heading text-lg text-slate-900">Pay rates</h2>
      <p className="px-0.5 text-sm text-slate-500">
        The tax bands and SSNIT rates change by law, and they changed on 1 September 2026. These are the school&rsquo;s own copy. A run is only
        approved on rates someone has checked against GRA&rsquo;s PAYE table and SSNIT&rsquo;s published rates and confirmed here.
      </p>

      {sets.length === 0 ? <p className="rounded-card border border-hairline bg-surface px-4.5 py-4 text-sm text-slate-500">No rates yet. Use the standard set-up above.</p> : null}

      {sets.map((set) => (
        <Card
          key={set.id}
          title={`${set.label} · from ${day(set.effectiveFrom)}`}
          action={set.confirmed ? <StatusBadge status="CONFIRMED" /> : <StatusBadge status="PENDING" />}
        >
          {canRates ? (
            <>
              <RateSetForm
                frozen={set.runs > 0}
                initial={{
                  id: set.id,
                  label: set.label,
                  effectiveFrom: dateInput(set.effectiveFrom),
                  employee: String(set.employee),
                  employer: String(set.employer),
                  tier2: String(set.tier2),
                  maxInsurable: String(set.maxInsurable),
                  bandsText: set.bandsText,
                }}
              />
              <div className="grid gap-3 border-t border-hairline px-4.5 py-4 sm:grid-cols-2">
                {set.confirmed ? null : <ConfirmRatesButton id={set.id} />}
                {set.runs === 0 ? <DeleteRatesButton id={set.id} /> : <p className="text-sm text-slate-500">Used by {set.runs} payroll {set.runs === 1 ? "run" : "runs"}.</p>}
              </div>
            </>
          ) : (
            <dl className="grid gap-2 px-4.5 py-4 text-sm sm:grid-cols-2">
              <div><dt className="text-slate-500">Employee SSNIT</dt><dd>{set.employee}%</dd></div>
              <div><dt className="text-slate-500">Employer SSNIT</dt><dd>{set.employer}%</dd></div>
              <div className="sm:col-span-2"><dt className="text-slate-500">PAYE bands</dt><dd><pre className="whitespace-pre-wrap font-mono text-xs">{set.bandsText}</pre></dd></div>
            </dl>
          )}
        </Card>
      ))}

      {canRates ? (
        <Card title="Add new rates">
          <RateSetForm
            frozen={false}
            initial={{
              id: "",
              label: "",
              effectiveFrom: "",
              employee: String(latest?.employee ?? STARTING_RATES.ssnitEmployeePercent),
              employer: String(latest?.employer ?? STARTING_RATES.ssnitEmployerPercent),
              tier2: String(latest?.tier2 ?? STARTING_RATES.ssnitTier2Percent),
              maxInsurable: String(latest?.maxInsurable ?? STARTING_RATES.ssnitMaxInsurable),
              bandsText: latest?.bandsText ?? bandsToText(STARTING_RATES.taxBands),
            }}
          />
        </Card>
      ) : (
        <p className="text-sm text-slate-500">A head teacher or the proprietor changes and confirms the rates.</p>
      )}

      <h2 className="px-0.5 pt-2 font-heading text-lg text-slate-900">Accounts a run posts to</h2>
      <Card>
        <AccountsForm accounts={accounts} mapping={mapping} />
        <p className="border-t border-hairline px-4.5 py-3 text-xs text-slate-500">
          Any left on &ldquo;Not posted&rdquo; means an approved run is not written to the accounts, and says so when it is approved.
        </p>
      </Card>
    </div>
  );
}

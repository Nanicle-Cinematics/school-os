"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  confirmSetup,
  regenerateRecoveryCodes,
  replaceAuthenticator,
  submitEnrolmentCode,
  type TwoFactorState,
} from "@/lib/platform-2fa-actions";
import { buttonClass } from "../../(app)/button-style";

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-center font-mono tracking-widest outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="rounded-lg border border-warning-ink/30 bg-warning-tint p-4">
      <p className="text-sm font-semibold text-warning-ink">Save these recovery codes now</p>
      <p className="mt-1 text-xs text-warning-ink">
        Each works once, if you lose your phone. They are shown only this one time — keep them
        somewhere safe and offline, not in the same place as your password.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-1.5 font-mono text-sm text-slate-900">
        {codes.map((code) => (
          <li key={code} className="rounded bg-white px-2 py-1 text-center">
            {code}
          </li>
        ))}
      </ul>
      <Link href="/admin" className={`${buttonClass("primary")} mt-4 inline-flex`}>
        I have saved them — open the console
      </Link>
    </div>
  );
}

function CodeField() {
  return (
    <input
      name="code"
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      required
      placeholder="123 456"
      className={inputClass}
    />
  );
}

function ErrorLine({ error }: { error?: string }) {
  return error ? (
    <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger-ink">
      {error}
    </p>
  ) : null;
}

/** Before anything else: the one-time code that was sent separately from the password. */
export function EnrolmentCodeForm() {
  const [state, action, pending] = useActionState<TwoFactorState, FormData>(submitEnrolmentCode, {});
  return (
    <form action={action} className="space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-slate-700">Enrolment code</span>
        <input
          name="enrolmentCode"
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          placeholder="XXXX-XXXX-XXXX"
          className={inputClass}
        />
      </label>
      <ErrorLine error={state.error} />
      <button type="submit" disabled={pending} className={buttonClass("primary")}>
        {pending ? "Checking…" : "Continue"}
      </button>
    </form>
  );
}

/** First step after scanning: prove the app has the secret, then show the recovery codes. */
export function ConfirmSetupForm() {
  const [state, action, pending] = useActionState<TwoFactorState, FormData>(confirmSetup, {});
  if (state.recoveryCodes) {
    return <RecoveryCodes codes={state.recoveryCodes} />;
  }
  return (
    <form action={action} className="space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-slate-700">
          Enter the 6-digit code the app now shows
        </span>
        <CodeField />
      </label>
      <ErrorLine error={state.error} />
      <button type="submit" disabled={pending} className={buttonClass("primary")}>
        {pending ? "Checking…" : "Turn on two-factor sign-in"}
      </button>
    </form>
  );
}

export function ManageForms({ recoveryLeft }: { recoveryLeft: number }) {
  const [regen, regenAction, regenPending] = useActionState<TwoFactorState, FormData>(
    regenerateRecoveryCodes,
    {},
  );
  const [replace, replaceAction, replacePending] = useActionState<TwoFactorState, FormData>(
    replaceAuthenticator,
    {},
  );

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Recovery codes</h2>
        <p className="text-sm text-slate-500">
          {recoveryLeft} unused recovery code{recoveryLeft === 1 ? "" : "s"} left. Make a fresh set
          if you are running low or think they were seen; the old ones stop working.
        </p>
        {regen.recoveryCodes ? (
          <RecoveryCodes codes={regen.recoveryCodes} />
        ) : (
          <form action={regenAction} className="flex flex-wrap items-start gap-3">
            <div className="w-40">
              <CodeField />
            </div>
            <button type="submit" disabled={regenPending} className={buttonClass("secondary")}>
              {regenPending ? "Checking…" : "Make new recovery codes"}
            </button>
            <div className="w-full">
              <ErrorLine error={regen.error} />
            </div>
          </form>
        )}
      </section>

      <section className="space-y-3 border-t border-slate-100 pt-5">
        <h2 className="text-sm font-semibold text-slate-900">New phone?</h2>
        <p className="text-sm text-slate-500">
          Replace the authenticator. This signs you out of every other session and walks you
          through setting up again.
        </p>
        <form action={replaceAction} className="flex flex-wrap items-start gap-3">
          <div className="w-40">
            <CodeField />
          </div>
          <button type="submit" disabled={replacePending} className={buttonClass("secondary")}>
            {replacePending ? "Checking…" : "Replace authenticator"}
          </button>
          <div className="w-full">
            <ErrorLine error={replace.error} />
          </div>
        </form>
      </section>
    </div>
  );
}

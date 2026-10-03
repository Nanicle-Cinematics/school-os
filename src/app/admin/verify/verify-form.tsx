"use client";

import { useActionState } from "react";
import { verifyLogin, type TwoFactorState } from "@/lib/platform-2fa-actions";
import { buttonClass } from "../../(app)/button-style";

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2.5 text-center font-mono text-lg tracking-widest outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

export function VerifyForm() {
  const [state, action, pending] = useActionState<TwoFactorState, FormData>(verifyLogin, {});
  return (
    <form action={action} className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-slate-700">Code</span>
        <input
          name="code"
          type="text"
          inputMode="text"
          autoComplete="one-time-code"
          autoFocus
          required
          placeholder="123 456"
          className={inputClass}
        />
        <span className="mt-1.5 block text-xs text-slate-400">
          The six digits from your authenticator app — or one of your recovery codes if the phone
          is lost.
        </span>
      </label>
      {state.error ? (
        <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger-ink">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className={`${buttonClass("primary")} w-full justify-center`}>
        {pending ? "Checking…" : "Continue"}
      </button>
    </form>
  );
}

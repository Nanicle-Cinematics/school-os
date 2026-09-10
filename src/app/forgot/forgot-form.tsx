"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { askForCode, useCode, type ForgotState } from "@/lib/forgot-actions";

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500";

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

/** Step one: ask for a code. */
function AskForm({ onSent }: { onSent: (state: ForgotState) => void }) {
  const [state, formAction] = useActionState<ForgotState, FormData>(async (prev, data) => {
    const next = await askForCode(prev, data);
    if (next.sent) {
      onSent(next);
    }
    return next;
  }, {});

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="phone" className="mb-1.5 block text-sm font-medium text-slate-700">
          Your phone number
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          placeholder="0244000000"
          required
          className={inputClass}
        />
        <p className="mt-1.5 text-xs text-slate-500">
          The number the school has for you. Type it the way you know it.
        </p>
      </div>

      {state.error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}

      <SubmitButton label="Send me a code" pendingLabel="Sending…" />
    </form>
  );
}

/** Step two: spend it, and choose a password. */
function CodeForm({ phone, notice }: { phone: string; notice?: string }) {
  const [state, formAction] = useActionState<ForgotState, FormData>(useCode, {});
  const done = Boolean(state.ok);

  if (done) {
    return (
      <div className="space-y-4">
        <p role="alert" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          {state.ok}
        </p>
        <Link
          href="/login"
          className="block w-full rounded-lg bg-brand-600 px-4 py-2.5 text-center text-sm font-medium text-white transition hover:bg-brand-700"
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {notice ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{notice}</p>
      ) : null}

      <input type="hidden" name="phone" value={phone} />

      <div>
        <label htmlFor="code" className="mb-1.5 block text-sm font-medium text-slate-700">
          The 6-digit code
        </label>
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          className={`${inputClass} tracking-[0.4em]`}
        />
      </div>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-700">
          New password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="confirm" className="mb-1.5 block text-sm font-medium text-slate-700">
          Type it again
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          className={inputClass}
        />
      </div>

      {state.error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}

      <SubmitButton label="Set my password" pendingLabel="Setting…" />
    </form>
  );
}

export function ForgotForm() {
  const [sent, setSent] = useState<ForgotState | null>(null);

  return sent?.phone ? (
    <CodeForm phone={sent.phone} notice={sent.ok} />
  ) : (
    <AskForm onSent={setSent} />
  );
}

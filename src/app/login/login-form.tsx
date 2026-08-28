"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { login, type LoginState } from "@/lib/auth-actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-800 disabled:opacity-60"
    >
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

export function LoginForm() {
  const [showPassword, setShowPassword] = useState(false);
  const [state, formAction] = useActionState<LoginState, FormData>(login, {});

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="identifier" className="mb-1.5 block text-sm font-medium text-slate-700">
          Email or phone number
        </label>
        <input
          id="identifier"
          name="identifier"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          required
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-brand-600 focus:ring-1 focus:ring-brand-600"
        />
      </div>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-700">
          Password
        </label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 pr-16 text-sm outline-none focus:border-brand-600 focus:ring-1 focus:ring-brand-600"
          />
          {/* Temporary passwords here are generated and dictated over the phone,
              so being able to check what was typed matters more than usual. */}
          <button
            type="button"
            onClick={() => setShowPassword((shown) => !shown)}
            aria-pressed={showPassword}
            aria-controls="password"
            className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-slate-500 transition hover:text-slate-900"
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {state.error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  );
}

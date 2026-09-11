import type { Metadata } from "next";
import Link from "next/link";
import { redirectIfAuthenticated } from "@/lib/auth";
import { ForgotForm } from "./forgot-form";

export const metadata: Metadata = { title: "Forgotten password · School OS" };

/**
 * Outside both (app) and (portal), like /login and /account/password.
 *
 * Those layouts divert a signed-in session to the change-password screen; a page
 * for someone who cannot sign in at all must sit where no such redirect can
 * reach it, or the two chase each other — the same trap `landingFor` exists to
 * avoid for teachers.
 */
export default async function ForgotPasswordPage() {
  await redirectIfAuthenticated();

  return (
    <main className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 font-heading text-lg text-white">
            S
          </div>
          <h1 className="text-xl font-semibold text-slate-900">Forgotten your password</h1>
          <p className="mt-1 text-sm text-slate-500">
            For parents. We text a code to the number the school has for you.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
          <ForgotForm />
        </div>

        <p className="mt-6 text-center text-sm text-slate-500">
          <Link href="/login" className="font-medium text-brand-ink hover:underline">
            Back to sign in
          </Link>
        </p>

        {/* Staff have a person for this, and it is a faster answer than a text. */}
        <p className="mt-2 text-center text-xs text-slate-400">
          Teachers and office staff: ask your school to reset your password.
        </p>
      </div>
    </main>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { requireAuth } from "@/lib/auth";
import { landingFor } from "@/lib/permissions";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Change password · School OS" };

/**
 * Deliberately OUTSIDE both (app) and (portal).
 *
 * The layouts of those groups divert anyone still holding a temporary password
 * here. If this page lived inside either, that redirect would land on itself and
 * the two would chase each other — the same trap `landingFor` exists to avoid
 * for teachers. Being its own route also means one screen serves staff and
 * parents rather than two that can drift.
 */
export default async function ChangePasswordPage() {
  const auth = await requireAuth();

  const forced = auth.mustChangePassword;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 text-center">
        <h1 className="font-heading text-2xl font-extrabold tracking-tight text-slate-900">
          {forced ? "Choose your own password" : "Change your password"}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {forced
            ? "You are signed in with a temporary password the school gave you. Please replace it before you go on."
            : "You will stay signed in here. Any other device will be signed out."}
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-surface p-5">
        <PasswordForm />
      </div>

      {/* No way out while it is forced — leaving would defeat the point. */}
      {forced ? null : (
        <p className="mt-4 text-center text-sm">
          <Link href={landingFor(auth.roles)} className="font-semibold text-brand-ink hover:underline">
            Back
          </Link>
        </p>
      )}
    </div>
  );
}

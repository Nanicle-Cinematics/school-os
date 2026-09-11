import type { Metadata } from "next";
import { redirectIfAuthenticated } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · School OS" };

export default async function LoginPage() {
  await redirectIfAuthenticated();

  return (
    <main className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 font-heading text-lg text-white">
            S
          </div>
          <h1 className="text-xl font-semibold text-slate-900">Sign in to School OS</h1>
          <p className="mt-1 text-sm text-slate-500">
            Use the details your school administrator gave you.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
          <LoginForm />
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Nanicle Enterprise Solutions
        </p>
      </div>
    </main>
  );
}

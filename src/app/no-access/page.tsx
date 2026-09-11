import type { Metadata } from "next";
import { logout } from "@/lib/auth-actions";

export const metadata: Metadata = { title: "No access · School OS" };

export default function NoAccessPage() {
  return (
    <main className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-surface p-6 text-center">
        <h1 className="text-lg font-semibold text-slate-900">No school linked</h1>
        <p className="mt-1.5 text-sm text-slate-500">
          Your account is signed in but is not linked to any school yet. Ask your school
          administrator to add you, then sign in again.
        </p>
        <form action={logout} className="mt-5">
          <button
            type="submit"
            className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}

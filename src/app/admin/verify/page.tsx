import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requirePlatformAdminSession } from "@/lib/platform-auth";
import { logout } from "@/lib/auth-actions";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = { title: "Confirm it's you" };

export default async function VerifyPage() {
  const { user, session } = await requirePlatformAdminSession();
  if (!user.totpEnabledAt) {
    redirect("/admin/security");
  }
  if (session.mfaVerifiedAt) {
    redirect("/admin");
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm rounded-card border border-hairline bg-surface p-6 shadow-card">
        <p className="text-sm font-semibold text-slate-900">Nanicle console</p>
        <h1 className="mt-3 text-lg font-semibold text-slate-900">Confirm it&rsquo;s you</h1>
        <p className="mt-1 mb-5 text-sm text-slate-500">
          Signed in as {user.email ?? user.name}. Enter the code from your authenticator app to open
          the console.
        </p>
        <VerifyForm />
        <form action={logout} className="mt-4 text-center">
          <button type="submit" className="text-xs text-slate-500 hover:text-slate-900">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}

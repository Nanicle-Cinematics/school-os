import type { Metadata } from "next";
import Link from "next/link";
import { requirePlatformAdminUser } from "@/lib/platform-auth";
import { logout } from "@/lib/auth-actions";
import { PlatformPasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Choose your password" };

/**
 * Outside the console's own gate on purpose: `requirePlatformAdminSession` sends a
 * login on a temporary password HERE, so this page must not send it anywhere else.
 */
export default async function PlatformPasswordPage() {
  const { user } = await requirePlatformAdminUser();
  const forced = user.mustChangePassword;

  return (
    <main className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm rounded-card border border-hairline bg-surface p-6 shadow-card">
        <p className="text-sm font-semibold text-slate-900">Nanicle console</p>
        <h1 className="mt-3 text-lg font-semibold text-slate-900">
          {forced ? "Choose your own password" : "Change your password"}
        </h1>
        <p className="mt-1 mb-5 text-sm text-slate-500">
          {forced
            ? "You are signed in with a temporary password. Replace it before you go on."
            : "Any other device will be signed out."}
        </p>
        <PlatformPasswordForm />
        {forced ? (
          <form action={logout} className="mt-4 text-center">
            <button type="submit" className="text-xs text-slate-500 hover:text-slate-900">
              Sign out
            </button>
          </form>
        ) : (
          <p className="mt-4 text-center text-sm">
            <Link href="/admin" className="font-semibold text-brand-ink hover:underline">
              Back
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}

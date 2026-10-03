import type { Metadata } from "next";
import Link from "next/link";
import QRCode from "qrcode";
import { requirePlatformAdminSession } from "@/lib/platform-auth";
import { logout } from "@/lib/auth-actions";
import { startSetup } from "@/lib/platform-2fa-actions";
import { base32Encode, otpauthUri } from "@/lib/totp";
import { decryptSecret, encryptionKeyProblem } from "@/lib/totp-crypto";
import { buttonClass } from "../../(app)/button-style";
import { ConfirmSetupForm, ManageForms } from "./security-forms";

export const metadata: Metadata = { title: "Two-factor sign-in" };

export default async function SecurityPage() {
  const { user, session } = await requirePlatformAdminSession();
  const problem = encryptionKeyProblem();
  const enabled = Boolean(user.totpEnabledAt);
  const pending = !enabled && Boolean(user.totpSecretEnc);
  // Someone with an enabled factor who has not passed it this session must not read
  // the management page — it would let a password alone reach it.
  const locked = enabled && !session.mfaVerifiedAt;

  let qr: string | null = null;
  let manualKey: string | null = null;
  if (pending && !problem) {
    const secret = decryptSecret(user.totpSecretEnc!);
    manualKey = base32Encode(secret).replace(/(.{4})/g, "$1 ").trim();
    qr = await QRCode.toDataURL(otpauthUri(secret, user.email ?? user.name, "School OS (Nanicle)"), {
      margin: 1,
      width: 220,
    });
  }

  return (
    <main className="min-h-full bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-lg space-y-5 rounded-card border border-hairline bg-surface p-6 shadow-card">
        <div>
          <p className="text-sm font-semibold text-slate-900">Nanicle console</p>
          <h1 className="mt-2 text-lg font-semibold text-slate-900">Two-factor sign-in</h1>
        </div>

        {problem ? (
          <p role="alert" className="rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger-ink">
            {problem}
          </p>
        ) : locked ? (
          <p className="text-sm text-slate-600">
            Confirm your code first.{" "}
            <Link href="/admin/verify" className="font-medium text-brand-700 underline">
              Go to the code check
            </Link>
          </p>
        ) : enabled ? (
          <>
            <p className="rounded-lg bg-success-tint px-3 py-2 text-sm text-success-ink">
              Two-factor sign-in is on for {user.email ?? user.name}.
            </p>
            <ManageForms recoveryLeft={user.recoveryCodeHashes.length} />
            <Link href="/admin" className="inline-block text-sm text-slate-500 hover:text-slate-900">
              ← Back to the console
            </Link>
          </>
        ) : pending ? (
          <>
            <p className="text-sm text-slate-600">
              The console is closed until you turn this on. Scan the code with an authenticator app
              (Google Authenticator, Microsoft Authenticator, 1Password, Authy…), or type the key in
              by hand.
            </p>
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="QR code to scan with your authenticator app" width={220} height={220} className="mx-auto rounded border border-slate-200" />
            ) : null}
            <p className="text-center font-mono text-sm tracking-wider text-slate-700">{manualKey}</p>
            <ConfirmSetupForm />
          </>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              This console can see every school&rsquo;s records and subscriptions, so a password is
              not enough to open it. Set up a second step: a six-digit code from an authenticator
              app on your phone. The console stays closed until you do.
            </p>
            <form action={startSetup}>
              <button type="submit" className={buttonClass("primary")}>
                Set up two-factor sign-in
              </button>
            </form>
          </>
        )}

        <form action={logout} className="border-t border-slate-100 pt-3">
          <button type="submit" className="text-xs text-slate-500 hover:text-slate-900">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}

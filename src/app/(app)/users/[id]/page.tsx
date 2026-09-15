import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP, OFFICE, ROLE_ADMIN, canAccess, roleLabel } from "@/lib/permissions";
import { ASSIGNABLE_ROLES, PRIVILEGED_ROLES, getUserAccount } from "@/lib/user-data";
import { removeUserAccess, setAccountSuspended } from "@/lib/user-actions";
import { Card } from "../../ui";
import { SubmitButton } from "../../submit-button";
import { RolesForm, ResetPasswordForm } from "./account-forms";

export const metadata: Metadata = { title: "Account · School OS" };

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export default async function UserDetailPage({ params }: PageProps<"/users/[id]">) {
  const auth = await requireRole(OFFICE);
  // Suspend and reset are the helpdesk half and stay; removing access and
  // changing roles are grants, and belong to OFFICE.
  const mayGrant = canAccess(auth.roles, ROLE_ADMIN);
  const { id } = await params;
  const account = await getUserAccount(auth.schoolId, id);

  if (!account) {
    notFound();
  }

  const { user, roles, suspended, staffNo, activeSessions } = account;
  const isSelf = user.id === auth.userId;
  const canGrantPrivileged = canAccess(auth.roles, LEADERSHIP);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link href="/users" className="text-sm text-slate-500 hover:text-slate-900">
          ← Users
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          {user.name}
          {isSelf ? <span className="ml-2 text-sm font-normal text-slate-400">you</span> : null}
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {user.email ?? user.phone ?? "no sign-in address"}
          {staffNo ? ` · ${staffNo}` : ""} · {roles.map((role) => roleLabel(role)).join(", ")}
        </p>
      </div>

      <Card title="Account">
        <dl className="grid gap-3 p-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-slate-500">Status</dt>
            <dd className={`mt-0.5 font-medium ${suspended ? "text-danger-ink" : "text-success-ink"}`}>
              {suspended ? "Suspended" : "Active"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Last signed in</dt>
            <dd className="mt-0.5 text-slate-900">
              {user.lastLoginAt ? dateFmt.format(user.lastLoginAt) : "Never"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Open sessions</dt>
            <dd className="mt-0.5 tabular-nums text-slate-900">{activeSessions}</dd>
          </div>
        </dl>
      </Card>

      {mayGrant ? (
        <Card title="Roles">
          <RolesForm
            userId={user.id}
            roles={ASSIGNABLE_ROLES}
            selected={roles}
            privileged={PRIVILEGED_ROLES}
            canGrantPrivileged={canGrantPrivileged}
          />
        </Card>
      ) : (
        <Card title="Roles">
          <p className="p-4 text-sm text-slate-500">
            {roles.map((role) => roleLabel(role)).join(", ")} — changing this is a decision for the
            head or the proprietor.
          </p>
        </Card>
      )}

      <Card title="Password">
        <ResetPasswordForm userId={user.id} />
      </Card>

      <Card title="Access">
        <div className="space-y-4 p-4">
          <form action={setAccountSuspended} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="userId" value={user.id} />
            <input type="hidden" name="suspend" value={suspended ? "0" : "1"} />
            <SubmitButton variant="secondary" pendingLabel="Updating…">
              {suspended ? "Reinstate account" : "Suspend account"}
            </SubmitButton>
            <p className="text-xs text-slate-500">
              {isSelf
                ? "Blocked — you cannot suspend your own account."
                : suspended
                  ? "Restores their roles. They will need to sign in again."
                  : "Signs them out everywhere and blocks sign-in, keeping the account."}
            </p>
          </form>

          {/* Rendered, not hidden with a class: `hidden` leaves a working form
              in the page for anyone who opens devtools. The action is
              OFFICE-guarded server-side regardless — this is about not showing
              a button that would only refuse. */}
          {mayGrant ? (
          <form
            action={removeUserAccess}
            className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4"
          >
            <input type="hidden" name="userId" value={user.id} />
            <SubmitButton variant="danger" pendingLabel="Removing…">
              Remove access
            </SubmitButton>
            <p className="text-xs text-slate-500">
              {isSelf
                ? "Blocked — you cannot remove your own access."
                : "Drops their roles at this school. The person record and anything they recorded stay."}
            </p>
          </form>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

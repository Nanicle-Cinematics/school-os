import type { Metadata } from "next";
import type { Role } from "@prisma/client";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP, OFFICE, ROLE_ADMIN, ACCOUNT_CREATOR, canAccess, roleLabel } from "@/lib/permissions";
import { ASSIGNABLE_ROLES, PRIVILEGED_ROLES, getUserList } from "@/lib/user-data";
import { Alert, PageHeader } from "../ui";
import { UserPlus } from "lucide-react";
import { DataTable, Row, type Column } from "../primitives";
import { NewAccountForm } from "./account-form";

export const metadata: Metadata = { title: "Users · School OS" };

const COLUMNS: Column[] = [
  { label: "Name" },
  { label: "Signs in with" },
  { label: "Roles" },
  { label: "Last seen" },
  { label: "Status" },
];

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const ERRORS: Record<string, string> = {
  self: "You cannot suspend or remove your own access — ask another proprietor to do it.",
  "last-owner": "That is the last proprietor account. Give someone else the role first.",
  privileged: "Only a proprietor or head can remove a leadership account.",
};

export default async function UsersPage({ searchParams }: PageProps<"/users">) {
  const auth = await requireRole(OFFICE);
  // Creating a login assigns a role, and an account-creating role that picks
  // its own roles can mint itself into the money — so ACCOUNT_CREATOR (which
  // adds IT_ADMIN to ROLE_ADMIN) is paired with a wider set of LOCKED roles
  // below for anyone who is not a full ROLE_ADMIN: ACCOUNTANT and ADMIN are
  // added to PRIVILEGED_ROLES so an IT admin can open this form but cannot
  // pick a role that reaches the money or reopens this same door.
  const mayCreateAccounts = canAccess(auth.roles, ACCOUNT_CREATOR);
  const hasFullAccountAdmin = canAccess(auth.roles, ROLE_ADMIN);
  const lockedRoles: Role[] = hasFullAccountAdmin
    ? PRIVILEGED_ROLES
    : [...PRIVILEGED_ROLES, "ACCOUNTANT", "ADMIN"];
  const query = await searchParams;
  const { users, staffWithoutAccounts } = await getUserList(auth.schoolId);
  const canGrantPrivileged = canAccess(auth.roles, LEADERSHIP);

  const error = typeof query.error === "string" ? ERRORS[query.error] : undefined;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Users"
        subtitle={`${users.length} login${users.length === 1 ? "" : "s"} · ${
          staffWithoutAccounts.length
        } staff without one`}
        action={
          mayCreateAccounts ? (
            <NewAccountForm
              staff={staffWithoutAccounts}
              roles={ASSIGNABLE_ROLES}
              privileged={lockedRoles}
              canGrantPrivileged={canGrantPrivileged}
            />
          ) : null
        }
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
          <DataTable
            columns={COLUMNS}
            empty={{ icon: UserPlus, title: "No logins yet. Invite the head, the bursar and the class teachers.", action: undefined }}
          >
            {users.map((entry) => {
                  const suspended = entry.statuses.every((status) => status === "SUSPENDED");
                  return (
                    <Row key={entry.user.id}>
                      <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-900">
                        <Link href={`/users/${entry.user.id}`} className="hover:underline">
                          {entry.user.name}
                        </Link>
                        {entry.user.id === auth.userId ? (
                          <span className="ml-2 text-xs font-normal text-slate-400">you</span>
                        ) : null}
                        {entry.staffNo ? (
                          <span className="ml-2 font-mono text-xs font-normal text-slate-400">
                            {entry.staffNo}
                          </span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                        {entry.user.email ?? entry.user.phone ?? (
                          <span className="text-warning-ink">nothing set</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {entry.roles.map((role) => roleLabel(role)).join(", ")}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">
                        {entry.user.lastLoginAt ? (
                          dateFmt.format(entry.user.lastLoginAt)
                        ) : (
                          <span className="text-slate-400">never</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                            suspended
                              ? "bg-danger-tint text-danger-ink"
                              : entry.user.passwordHash
                                ? "bg-success-tint text-success-ink"
                                : "bg-warning-tint text-warning-ink"
                          }`}
                        >
                          {suspended ? "suspended" : entry.user.passwordHash ? "active" : "no password"}
                        </span>
                      </td>
                    </Row>
                  );
                })
              }
          </DataTable>

      {staffWithoutAccounts.length > 0 ? (
        <p className="text-xs text-slate-400">
          {staffWithoutAccounts.length} member
          {staffWithoutAccounts.length === 1 ? "" : "s"} of staff cannot sign in yet:{" "}
          {staffWithoutAccounts
            .slice(0, 6)
            .map((person) => `${person.firstName} ${person.lastName}`)
            .join(", ")}
          {staffWithoutAccounts.length > 6 ? "…" : ""}
        </p>
      ) : null}

      {mayCreateAccounts && !hasFullAccountAdmin ? (
        <p className="text-xs text-slate-400">
          As IT admin you can create a staff login, reset a password and suspend or restore one.
          A login with finance or administrator access, or a change to what an existing login is
          allowed to do, is a decision for the head or the proprietor.
        </p>
      ) : null}

      <p className="text-xs text-slate-400">
        Parent logins are not made here. Open{" "}
        <Link href="/guardians" className="underline hover:text-slate-600">
          Guardians
        </Link>
        , find the parent and give them a portal login — creating it from their own record is what
        ties the login to their children. It then appears in this list like any other. Pupils have
        no portal yet.
      </p>
    </div>
  );
}

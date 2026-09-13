import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP, OFFICE, canAccess, roleLabel } from "@/lib/permissions";
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
          <NewAccountForm
            staff={staffWithoutAccounts}
            roles={ASSIGNABLE_ROLES}
            privileged={PRIVILEGED_ROLES}
            canGrantPrivileged={canGrantPrivileged}
          />
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
                          <span className="text-amber-600">nothing set</span>
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
                              ? "bg-red-50 text-red-700"
                              : entry.user.passwordHash
                                ? "bg-green-50 text-green-700"
                                : "bg-amber-50 text-amber-700"
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

      <p className="text-xs text-slate-400">
        Parents and students are not listed — the enum has those roles, but there is no portal for
        them yet, so a login would land on the staff dashboard.
      </p>
    </div>
  );
}

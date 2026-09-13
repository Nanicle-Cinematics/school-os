import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getGuardianList } from "@/lib/guardian-data";
import { ButtonLink, PageHeader, filterClass } from "../ui";
import { Heart } from "lucide-react";
import { DataTable, Row, type Column } from "../primitives";
import { NewGuardianForm } from "./guardian-form";

export const metadata: Metadata = { title: "Guardians · School OS" };

const COLUMNS: Column[] = [
  { label: "Name" },
  { label: "Phone" },
  { label: "Children", numeric: true },
  { label: "Gets bills" },
];

export default async function GuardiansPage({ searchParams }: PageProps<"/guardians">) {
  await requireRole(OFFICE);
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const { guardians, total } = await getGuardianList(query);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Guardians"
        subtitle={
          query ? `${guardians.length} matching “${query}” of ${total}` : `${total} on file`
        }
        action={
          <div className="flex items-center gap-2">
            <ButtonLink href="/guardians/invites">Invite to portal</ButtonLink>
            <NewGuardianForm />
          </div>
        }
      />

      <form className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Name or phone number"
          className={`${filterClass} w-64`}
        />
        <button
          type="submit"
          className="whitespace-nowrap rounded-card border border-hairline bg-surface px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          Search
        </button>
      </form>
          <DataTable
            columns={COLUMNS}
            empty={{ icon: Heart, title: "No guardians on file yet. They are added with a pupil, or on their own here.", action: undefined }}
          >
            {guardians.map((guardian) => {
                  const bills = guardian.students.filter((link) => link.receivesBills).length;
                  return (
                    <Row key={guardian.id}>
                      <td className="whitespace-nowrap px-4 py-2.5 font-medium text-slate-900">
                        <Link href={`/guardians/${guardian.id}`} className="hover:underline">
                          {guardian.lastName}, {guardian.firstName}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-500">
                        {guardian.phone}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {guardian.students.length === 0 ? (
                          <span className="text-warning-ink">none linked</span>
                        ) : (
                          guardian.students
                            .map((link) => `${link.student.firstName} ${link.student.lastName}`)
                            .join(", ")
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-slate-600">
                        {bills}
                      </td>
                    </Row>
                  );
                })
              }
          </DataTable>

      <p className="text-xs text-slate-400">
        A guardian with no children linked receives nothing — no bill, no result, no closing-date
        notice.
      </p>
    </div>
  );
}

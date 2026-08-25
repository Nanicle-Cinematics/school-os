import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { getGuardianList } from "@/lib/guardian-data";
import { EmptyRow, PageHeader, inputClass, tableHeadClass, thClass } from "../ui";
import { NewGuardianForm } from "./guardian-form";

export const metadata: Metadata = { title: "Guardians · School OS" };

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
        action={<NewGuardianForm />}
      />

      <form className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Name or phone number"
          className={`${inputClass} w-64`}
        />
        <button
          type="submit"
          className="whitespace-nowrap rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Search
        </button>
      </form>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className={tableHeadClass}>
              <tr>
                <th className={thClass}>Name</th>
                <th className={thClass}>Phone</th>
                <th className={thClass}>Children</th>
                <th className={thClass}>Gets bills</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {guardians.length === 0 ? (
                <EmptyRow colSpan={4}>
                  {query ? "No guardian matches that." : "No guardians on file yet."}
                </EmptyRow>
              ) : (
                guardians.map((guardian) => {
                  const bills = guardian.students.filter((link) => link.receivesBills).length;
                  return (
                    <tr key={guardian.id} className="hover:bg-slate-50">
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
                          <span className="text-amber-600">none linked</span>
                        ) : (
                          guardian.students
                            .map((link) => `${link.student.firstName} ${link.student.lastName}`)
                            .join(", ")
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-slate-600">
                        {bills}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-slate-400">
        A guardian with no children linked receives nothing — no bill, no result, no closing-date
        notice.
      </p>
    </div>
  );
}

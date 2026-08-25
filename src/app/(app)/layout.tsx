import { requireAuth } from "@/lib/auth";
import { navFor, roleLabel } from "@/lib/permissions";
import { logout } from "@/lib/auth-actions";
import { prisma } from "@/lib/prisma";
import { Sidebar, MobileNav } from "./nav";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // Establishes the tenant context for every query below this layout.
  const auth = await requireAuth();
  const sections = navFor(auth.roles);

  // The current term drives almost every screen, so the shell shows it.
  const term = await prisma.term.findFirst({
    where: { isCurrent: true },
    include: { academicYear: true },
  });

  const initials = auth.name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="flex min-h-full flex-col bg-slate-50">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white">
        <div className="flex h-14 items-center gap-3 px-4">
          <MobileNav sections={sections} />

          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-xs font-semibold text-white">
              {auth.schoolShortName?.slice(0, 2).toUpperCase() ?? "S"}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{auth.schoolName}</p>
              {term ? (
                <p className="truncate text-xs text-slate-500">
                  {term.name === "FIRST" ? "First" : term.name === "SECOND" ? "Second" : "Third"} Term ·{" "}
                  {term.academicYear.name}
                </p>
              ) : (
                <p className="truncate text-xs text-amber-600">No current term set</p>
              )}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium text-slate-900">{auth.name}</p>
              <p className="text-xs text-slate-500">
                {auth.roles.map(roleLabel).join(" · ")}
              </p>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">
              {initials}
            </div>
            <form action={logout}>
              <button
                type="submit"
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        <Sidebar sections={sections} />
        <main className="min-w-0 flex-1 p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}

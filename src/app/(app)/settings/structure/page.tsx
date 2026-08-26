import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { STAGES, getStructure } from "@/lib/structure-data";
import { Card } from "../../ui";
import {
  ApplyCurriculumForm,
  HouseSection,
  LevelSection,
  ProgrammeSection,
} from "./structure-forms";

export const metadata: Metadata = { title: "School structure · School OS" };

export default async function StructurePage() {
  await requireRole(OFFICE);
  const { levels, houses, programmes } = await getStructure();

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link href="/settings" className="text-sm text-slate-500 hover:text-slate-900">
          ← Settings
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">School structure</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          The ladder a child climbs, and the groups they belong to. Set this up before adding
          classes — a class needs a level to sit in.
        </p>
      </div>

      <Card title="GES curriculum">
        <ApplyCurriculumForm levelCount={levels.length} />
      </Card>

      <Card title={`Levels · ${levels.length}`}>
        {levels.length === 0 ? (
          <p className="px-4 pt-4 text-sm text-slate-500">
            No levels yet. Add them lowest first — the order column is what sorts every class list,
            broadsheet and fee table.
          </p>
        ) : null}
        <LevelSection levels={levels} stages={STAGES} />
      </Card>

      <Card title={`Houses · ${houses.length}`}>
        {houses.length === 0 ? (
          <p className="px-4 pt-4 text-sm text-slate-500">
            No houses. Optional — leave empty if the school does not run a house system.
          </p>
        ) : null}
        <HouseSection houses={houses} />
      </Card>

      <Card title={`Programmes · ${programmes.length}`}>
        {programmes.length === 0 ? (
          <p className="px-4 pt-4 text-sm text-slate-500">
            No programmes. Only SHS needs these — General Science, Business, Visual Arts and so on.
          </p>
        ) : null}
        <ProgrammeSection programmes={programmes} />
      </Card>

      <p className="text-xs text-slate-400">
        A level, house or programme that is in use cannot be deleted — classes, fee tables and
        student records all hang off them. Rename it instead.
      </p>
    </div>
  );
}
